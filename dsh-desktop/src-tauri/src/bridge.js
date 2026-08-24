// dsh-desktop frontend transport shim.
// Replaces fetch/WebSocket for dsh:// loopback traffic with Tauri IPC calls,
// so the shipped DeepSeek Harness web client runs unchanged with zero TCP
// ports. Run before any client module: the Rust shell injects this script
// into index.html inside <head>.
(function installDshBridge() {
  'use strict';

  var __TAURI__ = window.__TAURI__;
  if (!__TAURI__ || !__TAURI__.core || !__TAURI__.core.invoke) {
    console.error('[dsh-desktop] Tauri global API unavailable; transport shim not installed');
    return;
  }
  var invoke = function invoke(cmd, args) {
    return __TAURI__.core.invoke(cmd, args || {});
  };
  var Channel = __TAURI__.core.Channel;
  var listen = function listen(name, handler) {
    return __TAURI__.event.listen(name, handler);
  };
  var rustLog = function rustLog(text) {
    void invoke('bridge_log', { message: String(text) });
  };

  // -------------------------------------------------------------------------
  // titlebar drag region. With TitleBarStyle::Overlay there is no visible
  // AppKit title strip, so the top 26px behaves like one: blank areas drag
  // the window; controls keep receiving their clicks.
  //
  // The window is moved MANUALLY with incremental logical-pixel deltas over
  // IPC. tao's native start_dragging on macOS only honors the FIRST call —
  // it replays NSApplication.currentEvent, which is stale by the time the
  // second mousedown arrives, so every later drag was silently dropped.
  // -------------------------------------------------------------------------
  var TITLEBAR_DRAG_HEIGHT = 26;
  var TITLEBAR_INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY', 'VIDEO', 'AUDIO']);
  var TITLEBAR_INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option', 'textbox', 'searchbox']);

  function titlebarBlocksDrag(node) {
    var current = node;
    while (current && current !== document.body && current !== document.documentElement) {
      if (current instanceof Element) {
        if (TITLEBAR_INTERACTIVE_TAGS.has(current.tagName)) return true;
        var role = current.getAttribute && current.getAttribute('role');
        if (role && TITLEBAR_INTERACTIVE_ROLES.has(role)) return true;
        if (current.hasAttribute && current.hasAttribute('contenteditable') && current.getAttribute('contenteditable') !== 'false') return true;
        if (current.className && typeof current.className === 'string' && current.className.indexOf('tabBar') !== -1) return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  // Input gate for the drag/resize handlers. Normally only trusted (real
  // hardware) events are handled — injected events from page scripts must
  // not move the window. While the synthetic selftest runs it sets
  // __DSH_SELFTEST__ and the gate flips: ONLY synthetic events pass, so a
  // human poking the window cannot pollute the measurements.
  function inputEventAllowed(event) {
    if (window.__DSH_SELFTEST__ === true) return !event.isTrusted;
    return event.isTrusted;
  }

  var dragState = {
    active: false,
    beginPending: false,
    lastX: 0,
    lastY: 0,
    pendingDx: 0,
    pendingDy: 0,
    sending: false,
    raf: null,
  };

  function sendMoveDelta() {
    var state = dragState;
    if (state.sending) return;
    if (state.pendingDx === 0 && state.pendingDy === 0 && !state.beginPending) return;
    state.sending = true;
    // `begin` makes the shell re-read the real frame position instead of
    // applying to its per-drag cache (stale after native zoom/restore).
    var begin = state.beginPending;
    state.beginPending = false;
    var dx = state.pendingDx;
    var dy = state.pendingDy;
    state.pendingDx = 0;
    state.pendingDy = 0;
    invoke('shell_window_move', { dx: dx, dy: dy, begin: begin })
      .catch(function (error) {
        rustLog('titlebar move failed: ' + (error && error.message ? error.message : error));
      })
      .finally(function () {
        state.sending = false;
        scheduleMoveSend();
      });
  }

  function scheduleMoveSend() {
    var state = dragState;
    if (state.raf !== null) return;
    state.raf = requestAnimationFrame(function () {
      state.raf = null;
      sendMoveDelta();
    });
  }

  function installTitlebarDrag() {
    document.addEventListener('mousedown', function (event) {
      if (event.button !== 0 || (event.detail !== 1 && event.detail !== 2)) return;
      if (event.clientY < 0 || event.clientY > TITLEBAR_DRAG_HEIGHT) return;
      if (titlebarBlocksDrag(event.target)) return;
      var internals = window.__TAURI_INTERNALS__;
      if (!internals || typeof internals.invoke !== 'function') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.detail === 2) {
        // Native zoom (with the macOS animation); single-press dragging is
        // handled by the pointer handlers below.
        try {
          internals.invoke('plugin:window|internal_toggle_maximize');
        } catch (error) {
          rustLog('titlebar zoom failed: ' + (error && error.message ? error.message : error));
        }
      }
    }, true);

    document.addEventListener('pointerdown', function (event) {
      if (!inputEventAllowed(event)) return;
      if (event.button !== 0 || !event.isPrimary || event.detail !== 1) return;
      if (dragState.active) return;
      if (event.clientY < 0 || event.clientY > TITLEBAR_DRAG_HEIGHT) return;
      if (titlebarBlocksDrag(event.target)) return;
      dragState.active = true;
      dragState.beginPending = true;
      // Deltas accumulate from SCREEN coordinates, not clientX/Y: moving the
      // window shifts the viewport origin, and macOS posts fresh mouse-moved
      // events for the (physically stationary) cursor after each move. With
      // client coordinates that injects the negation of our own movement as
      // a new delta — the window oscillates forever. Screen coordinates are
      // window-independent, so a stationary cursor always yields zero delta.
      dragState.lastX = event.screenX;
      dragState.lastY = event.screenY;
      dragState.pendingDx = 0;
      dragState.pendingDy = 0;
      if (event.target && event.target.setPointerCapture) {
        try {
          event.target.setPointerCapture(event.pointerId);
        } catch (_) {
          // pointer capture is best effort; window-bounded dragging still works
        }
      }
    }, true);

    document.addEventListener('pointermove', function (event) {
      if (!inputEventAllowed(event)) return;
      if (!dragState.active || !event.isPrimary) return;
      var samples = event.getCoalescedEvents ? event.getCoalescedEvents() : null;
      if (!samples || samples.length <= 1) {
        samples = [event];
      }
      for (var i = 0; i < samples.length; i += 1) {
        dragState.pendingDx += samples[i].screenX - dragState.lastX;
        dragState.pendingDy += samples[i].screenY - dragState.lastY;
        dragState.lastX = samples[i].screenX;
        dragState.lastY = samples[i].screenY;
      }
      scheduleMoveSend();
    }, true);

    function finishDrag(event) {
      if (!inputEventAllowed(event)) return;
      if (!dragState.active) return;
      // The pointer-up location is the final sample: the segment between the
      // last pointermove and the actual release point would otherwise be
      // dropped, leaving the window short of where the mouse ended up.
      if (event.type === 'pointerup') {
        dragState.pendingDx += event.screenX - dragState.lastX;
        dragState.pendingDy += event.screenY - dragState.lastY;
      }
      dragState.active = false;
      // sendMoveDelta does not gate on `active`, so the tail is never dropped.
      if (dragState.pendingDx !== 0 || dragState.pendingDy !== 0) scheduleMoveSend();
    }
    document.addEventListener('pointerup', finishDrag, true);
    document.addEventListener('pointercancel', finishDrag, true);
  }

  // -------------------------------------------------------------------------
  // custom west/east/south edge resize. macOS only has native corner resize;
  // left/right edge handles are provided here with incremental logical-pixel
  // deltas serialized through a single in-flight IPC resize.
  // -------------------------------------------------------------------------
  var RESIZE_EDGE_SIZE = 7;
  var resizeState = {
    edge: null,
    tailEdge: null,
    lastX: 0,
    lastY: 0,
    pendingDx: 0,
    pendingDy: 0,
    sending: false,
    raf: null,
  };

  function edgeAt(clientX, clientY) {
    if (clientY < TITLEBAR_DRAG_HEIGHT) return null;
    var width = window.innerWidth;
    var height = window.innerHeight;
    var west = clientX <= RESIZE_EDGE_SIZE;
    var east = clientX >= width - RESIZE_EDGE_SIZE;
    var south = clientY >= height - RESIZE_EDGE_SIZE;
    if (west && south) return 'southwest';
    if (east && south) return 'southeast';
    if (west) return 'west';
    if (east) return 'east';
    if (south) return 'south';
    return null;
  }

  function resizeCursor(edge) {
    if (edge === 'west' || edge === 'east') return 'ew-resize';
    if (edge === 'south') return 'ns-resize';
    if (edge === 'southwest' || edge === 'southeast') return edge === 'southwest' ? 'nesw-resize' : 'nwse-resize';
    return '';
  }

  function sendResizeDelta() {
    var state = resizeState;
    if (state.sending) return;
    // A finished drag keeps its edge in tailEdge so the final accumulated
    // pixels are still applied instead of being dropped on the floor.
    var edge = state.edge !== null ? state.edge : state.tailEdge;
    if (edge === null) return;
    if (state.pendingDx === 0 && state.pendingDy === 0) return;
    state.sending = true;
    state.tailEdge = null;
    var dx = state.pendingDx;
    var dy = state.pendingDy;
    state.pendingDx = 0;
    state.pendingDy = 0;
    invoke('shell_window_resize', { edge: edge, dx: dx, dy: dy })
      .catch(function (error) {
        rustLog('edge resize failed: ' + (error && error.message ? error.message : error));
      })
      .finally(function () {
        state.sending = false;
        scheduleResizeSend();
      });
  }

  function scheduleResizeSend() {
    var state = resizeState;
    if (state.raf !== null) return;
    state.raf = requestAnimationFrame(function () {
      state.raf = null;
      sendResizeDelta();
    });
  }

  // Cursor writes invalidate styles; only touch the DOM when the value
  // actually changes, or every mousemove costs a style recalc.
  var lastCursor = '';
  function setBodyCursor(value) {
    if (value === lastCursor) return;
    lastCursor = value;
    document.body.style.cursor = value;
  }

  function installEdgeResize() {
    document.addEventListener('mousemove', function (event) {
      var edge = resizeState.edge !== null ? resizeState.edge : edgeAt(event.clientX, event.clientY);
      setBodyCursor(resizeCursor(edge));
    });

    function accumulatePointerMove(event) {
      var samples = event.getCoalescedEvents ? event.getCoalescedEvents() : null;
      if (!samples || samples.length <= 1) {
        samples = [event];
      }
      for (var i = 0; i < samples.length; i += 1) {
        var sample = samples[i];
        // Screen coordinates: west-edge resizes move the window origin, and
        // clientX-based deltas would feed our own movement back as input
        // (infinite oscillation). See the drag handler for the full story.
        resizeState.pendingDx += sample.screenX - resizeState.lastX;
        resizeState.pendingDy += sample.screenY - resizeState.lastY;
        resizeState.lastX = sample.screenX;
        resizeState.lastY = sample.screenY;
      }
    }

    document.addEventListener('pointerdown', function (event) {
      if (!inputEventAllowed(event)) return;
      if (event.button !== 0 || !event.isPrimary || resizeState.edge !== null) return;
      var edge = edgeAt(event.clientX, event.clientY);
      if (edge === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      resizeState.edge = edge;
      resizeState.lastX = event.screenX;
      resizeState.lastY = event.screenY;
      resizeState.pendingDx = 0;
      resizeState.pendingDy = 0;
      if (event.target && event.target.setPointerCapture) {
        try {
          event.target.setPointerCapture(event.pointerId);
        } catch (_) {
          // pointer capture is best effort; window-bounded resizing still works
        }
      }
    }, true);

    document.addEventListener('pointermove', function (event) {
      if (!inputEventAllowed(event)) return;
      if (resizeState.edge === null || !event.isPrimary) return;
      accumulatePointerMove(event);
      scheduleResizeSend();
    }, true);

    function finishResize(event) {
      if (!inputEventAllowed(event)) return;
      if (resizeState.edge === null) return;
      // Count the release point as the final sample (same tail fix as drag).
      if (event.type === 'pointerup') {
        accumulatePointerMove(event);
      }
      // Keep the edge for the tail flush; sendResizeDelta consumes it.
      resizeState.tailEdge = resizeState.edge;
      resizeState.edge = null;
      if (resizeState.pendingDx !== 0 || resizeState.pendingDy !== 0) scheduleResizeSend();
      document.body.style.cursor = '';
      lastCursor = '';
    }
    document.addEventListener('pointerup', finishResize, true);
    document.addEventListener('pointercancel', finishResize, true);
  }

  var RealWebSocket = window.WebSocket;
  var nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : undefined;

  var fetchSeq = 0;
  var wsSeq = 0;

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  function bytesToBase64(bytes) {
    var binary = '';
    var chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toAbsoluteUrl(input) {
    if (typeof input === 'string' && /^https?:\/\//.test(input)) return new URL(input);
    return new URL(input, window.location.origin);
  }

  function isLoopbackAuthority(hostname) {
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    if (/^[a-z0-9-]+\.localhost$/i.test(hostname)) return true;
    var parts = hostname.split('.');
    if (parts.length === 4 && parts[0] === '127') {
      return parts.every(function (p) {
        return /^\d{1,3}$/.test(p) && Number(p) <= 255;
      });
    }
    return false;
  }

  function headersObject(headers) {
    var out = {};
    if (!headers) return out;
    if (headers.forEach) {
      headers.forEach(function (value, key) {
        out[key] = value;
      });
    } else if (typeof headers === 'object') {
      Object.keys(headers).forEach(function (key) {
        out[key] = String(headers[key]);
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // fetch shim
  // -------------------------------------------------------------------------
  function bridgedFetch(input, init) {
    var reqId = 'f' + ++fetchSeq;
    var url = toAbsoluteUrl(input);
    var signal = init && init.signal ? init.signal : undefined;
    var streamId = reqId;
    var channel = new Channel();
    var state = { status: 200, headers: {}, body: null, error: null, ended: false, aborting: false, streamClosed: false };
    var controller;
    var started = false;
    function closeStream() {
      if (state.streamClosed) return;
      state.streamClosed = true;
      try {
        if (controller !== undefined) controller.close();
      } catch (error) {
        rustLog('close-error ' + url.pathname + ': ' + (error && error.message ? error.message : error));
      }
    }
    function errorStream(error) {
      if (state.streamClosed) return;
      state.streamClosed = true;
      try {
        if (controller !== undefined) controller.error(error);
      } catch (_) {}
    }

    // Register the channel callback immediately: Tauri Channel drops frames
    // that arrive before an onmessage callback has been assigned.
    channel.onmessage = function (frame) {
      if (state.aborting) return;
      if (!frame || typeof frame !== 'object') return;
      switch (frame.kind) {
        case 'chunk':
        case 'headers':
          break;
        case 'end':
          state.ended = true;
          if (started) closeStream();
          break;
        case 'error':
          state.error = frame.message || 'host request failed';
          rustLog('fetch-error ' + url.pathname + ': ' + state.error);
          errorStream(new Error(state.error));
          break;
        default:
          break;
      }
      if (frame.kind === 'chunk') {
        if (started) {
          try {
            controller && controller.enqueue(base64ToBytes(frame.data || ''));
          } catch (_) {
            // stream already closed
          }
        } else {
          state.queue.push(frame);
        }
      }
    };
    state.queue = [];

    var startedPromise = null;
    function start() {
      if (startedPromise) return startedPromise;
      startedPromise = (async function () {
        var bodyB64 = null;
        if (init && init.body != null) {
          var bytes = init.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(await new Response(init.body).arrayBuffer());
          if (bytes.byteLength > 0) bodyB64 = bytesToBase64(bytes);
        }
        var start = await invoke('bridge_fetch', {
          url: url.href,
          method: init && init.method ? init.method : 'GET',
          headers: headersObject(init && init.headers),
          body: bodyB64,
          reqId: reqId,
          channel: channel,
        });
        state.status = (start && start.status) || 200;
        state.headers = (start && start.headers) || {};
        started = true;
        while (state.queue.length > 0) {
          if (controller !== undefined && !state.streamClosed) {
            try {
              controller.enqueue(base64ToBytes(state.queue.shift().data || ''));
            } catch (_) {}
          } else {
            state.queue.shift();
          }
        }
        if (state.ended) closeStream();
        return start;
      })();
      return startedPromise;
    }

    return new Promise(function (resolve, reject) {
      if (signal !== undefined && signal.aborted) {
        reject(makeAbortError());
        return;
      }
      var responded = false;
      var onAbort = function () {
        state.aborting = true;
        void invoke('bridge_fetch_abort', { reqId: reqId });
        if (!responded) {
          responded = true;
          reject(makeAbortError());
        } else {
          errorStream(makeAbortError());
        }
      };
      if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

      var stream = new ReadableStream({
        start: function (c) {
          controller = c;
        },
        cancel: function () {
          onAbort();
        },
      });
      start()
        .then(function () {
          if (state.aborting) return;
          responded = true;
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          resolve(new Response(stream, { status: state.status, headers: state.headers }));
        })
        .catch(function (error) {
          rustLog('fetch-reject ' + url.pathname + ': ' + (error && error.message ? error.message : error));
          responded = true;
          if (signal !== undefined) signal.removeEventListener('abort', onAbort);
          errorStream(error);
          reject(error);
        });
    });
  }

  function makeAbortError() {
    try {
      return new DOMException('This operation was aborted', 'AbortError');
    } catch (_) {
      var error = new Error('This operation was aborted');
      error.name = 'AbortError';
      return error;
    }
  }

  function ipcFetch(input, init) {
    init = init || {};
    var parsed = null;
    try {
      parsed = toAbsoluteUrl(input);
    } catch (_) {
      parsed = null;
    }
    var sameOrigin = parsed !== null && parsed.origin === window.location.origin;
    // Every same-origin fetch goes through the portless bridge. Limiting this
    // to /api breaks plugin routes such as SSE panels (/git/events, ...) that
    // stream forever and must not be buffered by the custom-protocol handler.
    if (sameOrigin) return bridgedFetch(parsed, init);
    if (nativeFetch === undefined) return Promise.reject(new Error('fetch unavailable'));
    return nativeFetch(input, init);
  }

  // -------------------------------------------------------------------------
  // WebSocket shim
  // -------------------------------------------------------------------------
  var WS_CONNECTING = 0;
  var WS_OPEN = 1;
  var WS_CLOSING = 2;
  var WS_CLOSED = 3;

  class IpcWebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = String(url);
      this.binaryType = 'blob';
      this.bufferedAmount = 0;
      this.extensions = '';
      this.protocol = '';
      this.readyState = WS_CONNECTING;
      this.CONNECTING = WS_CONNECTING;
      this.OPEN = WS_OPEN;
      this.CLOSING = WS_CLOSING;
      this.CLOSED = WS_CLOSED;
      this._handlers = {};
      this._closeEvent = null;
      this._unlisten = null;
      this._real = null;
      this._streamId = null;
      this._closed = false;

      var parsed = null;
      try {
        parsed = new URL(this.url);
      } catch (_) {
        parsed = null;
      }
      if (parsed !== null && isLoopbackAuthority(parsed.hostname)) {
        this._openIpc(parsed);
      } else if (parsed !== null && parsed.protocol === 'dsh:') {
        this._openIpc(parsed);
      } else {
        this._proxyReal(url, protocols);
      }
    }
  }

  Object.defineProperty(IpcWebSocket.prototype, 'onopen', {
    configurable: true,
    get: function () { return this._handlers.open || null; },
    set: function (fn) { this._setHandler('open', fn); },
  });
  Object.defineProperty(IpcWebSocket.prototype, 'onmessage', {
    configurable: true,
    get: function () { return this._handlers.message || null; },
    set: function (fn) { this._setHandler('message', fn); },
  });
  Object.defineProperty(IpcWebSocket.prototype, 'onclose', {
    configurable: true,
    get: function () { return this._handlers.close || null; },
    set: function (fn) { this._setHandler('close', fn); },
  });
  Object.defineProperty(IpcWebSocket.prototype, 'onerror', {
    configurable: true,
    get: function () { return this._handlers.error || null; },
    set: function (fn) { this._setHandler('error', fn); },
  });

  IpcWebSocket.prototype._setHandler = function (type, fn) {
    var previous = this._handlers[type];
    if (previous) this.removeEventListener(type, previous);
    this._handlers[type] = typeof fn === 'function' ? fn : null;
    if (this._handlers[type]) this.addEventListener(type, this._handlers[type]);
  };

  IpcWebSocket.prototype._dispatch = function (type, event) {
    this.dispatchEvent(event || new Event(type));
  };

  IpcWebSocket.prototype._openIpc = function (parsed) {
    var self = this;
    var streamId = 'w' + ++wsSeq;
    this._streamId = streamId;
    var path = parsed.pathname + parsed.search;

    listen('dsh:ws-frame', function (event) {
      var payload = event && event.payload ? event.payload : {};
      if (payload.streamId !== streamId || self.readyState !== WS_OPEN) return;
      if (payload.closed === true) {
        self._teardown();
        self.readyState = WS_CLOSED;
        var closeEvent;
        try {
          closeEvent = new CloseEvent('close', {
            code: typeof payload.code === 'number' ? payload.code : 1006,
            reason: typeof payload.reason === 'string' ? payload.reason : '',
          });
        } catch (_) {
          closeEvent = new Event('close');
        }
        self._dispatch('close', closeEvent);
        return;
      }
      var data = payload.data;
      if (typeof data === 'string') {
        self._dispatch('message', new MessageEvent('message', { data: data }));
      } else if (data && typeof data === 'object' && data.binary === true && typeof data.base64 === 'string') {
        var bytes = base64ToBytes(data.base64);
        if (self.binaryType === 'arraybuffer') {
          self._dispatch('message', new MessageEvent('message', { data: bytes.buffer }));
        } else {
          self._dispatch('message', new MessageEvent('message', { data: new Blob([bytes]) }));
        }
      }
    })
      .then(function (unlisten) {
        self._unlisten = unlisten;
        // Optimistically open from the renderer's point of view. The native
        // open command round-trip is ordered against concurrent streaming
        // fetch channels in the Tauri IPC queue and can resolve after the
        // DSH stream-open timeout, which would abort an otherwise healthy
        // generation. The Rust command still validates the route and, on
        // failure, emits dsh:ws-error below.
        var accept = invoke('bridge_ws_open', { streamId: streamId, path: path });
        accept.catch(function (error) {
          if (self._closed) return;
          rustLog('ws-error ' + self.url + ': ' + (error && error.message ? error.message : error));
          self._teardown();
          self.readyState = WS_CLOSED;
          self._dispatch('error', new Event('error'));
        });
        if (self._closed || self.readyState === WS_CLOSED) {
          void invoke('bridge_ws_close', { streamId: streamId });
          return;
        }
        self.readyState = WS_OPEN;
        self._dispatch('open', new Event('open'));
      })
      .catch(function (error) {
        if (self._closed) return;
        rustLog('ws-error ' + self.url + ': ' + (error && error.message ? error.message : error));
        self._teardown();
        self.readyState = WS_CLOSED;
        self._dispatch('error', new Event('error'));
      });
  };

  IpcWebSocket.prototype._teardown = function () {
    if (this._unlisten !== null) {
      try {
        this._unlisten();
      } catch (_) {}
      this._unlisten = null;
    }
  };

  IpcWebSocket.prototype._proxyReal = function (url, protocols) {
    var self = this;
    try {
      var real = new RealWebSocket(url, protocols);
      this._real = real;
      real.addEventListener('open', function () {
        self.readyState = WS_OPEN;
        self._dispatch('open', new Event('open'));
      });
      real.addEventListener('message', function (event) {
        self._dispatch('message', new MessageEvent('message', { data: event.data }));
      });
      real.addEventListener('close', function (event) {
        self.readyState = WS_CLOSED;
        self._dispatch('close', event);
      });
      real.addEventListener('error', function () {
        self._dispatch('error', new Event('error'));
      });
    } catch (_) {
      this.readyState = WS_CLOSED;
      queueMicrotask(function () {
        self._dispatch('error', new Event('error'));
      });
    }
  };

  IpcWebSocket.prototype.send = function (data) {
    if (this.readyState !== WS_OPEN || this._streamId === null) {
      if (this._real !== null && this._real.readyState === WS_OPEN) this._real.send(data);
      return;
    }
    if (typeof data === 'string') {
      void invoke('bridge_ws_send', { streamId: this._streamId, data: data });
      return;
    }
    if (data instanceof ArrayBuffer) {
      void invoke('bridge_ws_send', {
        streamId: this._streamId,
        base64: bytesToBase64(new Uint8Array(data)),
      });
      return;
    }
    if (ArrayBuffer.isView(data)) {
      void invoke('bridge_ws_send', {
        streamId: this._streamId,
        base64: bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
      });
      return;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then(function (buffer) {
        void invoke('bridge_ws_send', {
          streamId: this._streamId,
          base64: bytesToBase64(new Uint8Array(buffer)),
        });
      }.bind(this));
      return;
    }
    void invoke('bridge_ws_send', { streamId: this._streamId, data: String(data) });
  };

  IpcWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this._closed = true;
    if (this._streamId !== null) {
      void invoke('bridge_ws_close', {
        streamId: this._streamId,
        code: typeof code === 'number' ? code : 1000,
        reason: typeof reason === 'string' ? reason : '',
      });
      this._teardown();
    }
    if (this._real !== null) this._real.close(code, reason);
    var event;
    try {
      event = new CloseEvent('close', { code: typeof code === 'number' ? code : 1000, reason: typeof reason === 'string' ? reason : '' });
    } catch (_) {
      event = new Event('close');
    }
    this._dispatch('close', event);
  };

  IpcWebSocket.CONNECTING = WS_CONNECTING;
  IpcWebSocket.OPEN = WS_OPEN;
  IpcWebSocket.CLOSING = WS_CLOSING;
  IpcWebSocket.CLOSED = WS_CLOSED;

  // -------------------------------------------------------------------------
  // EventSource shim: plugin SSE routes stream through the bridge fetch
  // channel instead of the custom-protocol handler (which must buffer whole
  // responses). The parser implements the subset of the SSE wire format used
  // by DSH plugins: event/data/id plus comment and keep-alive lines.
  // -------------------------------------------------------------------------
  var LES_CONNECTING = 0;
  var LES_OPEN = 1;
  var LES_CLOSED = 2;
  var RealEventSource = window.EventSource;

  var sseHandlers = function (target) {
    var handlers = target._handlers || (target._handlers = {});
    Object.defineProperty(target, 'onopen', {
      configurable: true,
      get: function () { return handlers.open || null; },
      set: function (fn) { setPropertyHandler(target, handlers, 'open', fn); },
    });
    Object.defineProperty(target, 'onmessage', {
      configurable: true,
      get: function () { return handlers.message || null; },
      set: function (fn) { setPropertyHandler(target, handlers, 'message', fn); },
    });
    Object.defineProperty(target, 'onerror', {
      configurable: true,
      get: function () { return handlers.error || null; },
      set: function (fn) { setPropertyHandler(target, handlers, 'error', fn); },
    });
  };

  function setPropertyHandler(target, handlers, type, fn) {
    var previous = handlers[type];
    if (previous) target.removeEventListener(type, previous);
    handlers[type] = typeof fn === 'function' ? fn : null;
    if (handlers[type]) target.addEventListener(type, handlers[type]);
  }

  class IpcEventSource extends EventTarget {
    constructor(url, config) {
      super();
      this.url = String(url);
      this.withCredentials = Boolean(config && config.withCredentials);
      this.readyState = LES_CONNECTING;
      this.CONNECTING = LES_CONNECTING;
      this.OPEN = LES_OPEN;
      this.CLOSED = LES_CLOSED;
      this._abort = null;
      this._reconnectTimer = null;
      this._lastEventId = null;
      sseHandlers(this);
      this._connect();
    }

    _connect() {
      if (this.readyState === LES_CLOSED) return;
      var abort = new AbortController();
      this._abort = abort;
      var self = this;
      void bridgedFetch(new URL(this.url, window.location.origin), { signal: abort.signal })
        .then(function (response) {
          if (self.readyState === LES_CLOSED) return;
          if (!response.ok || !response.body) {
            self._fail();
            return;
          }
          self.readyState = LES_OPEN;
          self.dispatchEvent(new Event('open'));
          var reader = response.body.getReader();
          var decoder = new TextDecoder();
          var lineBuffer = '';
          var eventName = '';
          var dataLines = [];
          function dispatchEventFrame() {
            if (dataLines.length === 0) return;
            var event;
            try {
              event = new MessageEvent(eventName || 'message', {
                data: dataLines.join('\n'),
                lastEventId: self._lastEventId || '',
                origin: window.location.origin,
              });
            } catch (_) {
              event = new MessageEvent('message', { data: dataLines.join('\n') });
            }
            self.dispatchEvent(event);
            eventName = '';
            dataLines = [];
          }
          function pump() {
            return reader.read().then(function (result) {
              if (self.readyState === LES_CLOSED) return;
              if (result.done) {
                self._fail();
                return;
              }
              var text = decoder.decode(result.value, { stream: true });
              lineBuffer += text.replace(/\r\n/g, '\n');
              var lines = lineBuffer.split('\n');
              lineBuffer = lines.pop() || '';
              for (var i = 0; i < lines.length; i += 1) {
                var line = lines[i];
                if (line === '') {
                  dispatchEventFrame();
                  continue;
                }
                if (line[0] === ':') continue;
                var colon = line.indexOf(':');
                var field = colon === -1 ? line : line.slice(0, colon);
                var value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (field === 'event') eventName = value;
                else if (field === 'data') dataLines.push(value);
                else if (field === 'id') self._lastEventId = value;
              }
              return pump();
            }).catch(function () {
              if (self.readyState !== LES_CLOSED) self._fail();
            });
          }
          void pump();
        })
        .catch(function () {
          if (self.readyState !== LES_CLOSED) self._fail();
        });
    }

    _fail() {
      if (this.readyState === LES_CLOSED) return;
      this.readyState = LES_CONNECTING;
      this.dispatchEvent(new Event('error'));
      if (this._reconnectTimer !== null) return;
      this._reconnectTimer = setTimeout(function () {
        this._reconnectTimer = null;
        this._connect();
      }.bind(this), 2500);
    }

    close() {
      if (this.readyState === LES_CLOSED) return;
      this.readyState = LES_CLOSED;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      if (this._abort !== null) {
        this._abort.abort();
        this._abort = null;
      }
    }
  }

  IpcEventSource.CONNECTING = LES_CONNECTING;
  IpcEventSource.OPEN = LES_OPEN;
  IpcEventSource.CLOSED = LES_CLOSED;

  function routedEventSource(url, config) {
    var parsed = null;
    try {
      parsed = toAbsoluteUrl(url);
    } catch (_) {
      parsed = null;
    }
    if (parsed !== null && parsed.origin === window.location.origin) {
      return new IpcEventSource(parsed, config);
    }
    return new RealEventSource(url, config);
  }
  routedEventSource.CONNECTING = LES_CONNECTING;
  routedEventSource.OPEN = LES_OPEN;
  routedEventSource.CLOSED = LES_CLOSED;

  // -------------------------------------------------------------------------
  // install
  // -------------------------------------------------------------------------
  window.fetch = ipcFetch;
  window.WebSocket = IpcWebSocket;
  if (RealEventSource !== undefined) {
    window.EventSource = routedEventSource;
  }

  // -------------------------------------------------------------------------
  // window.open fallback: route the sign-in popup to the system browser.
  //
  // dsh-codex-connect drives OAuth through `window.open("about:blank")` and
  // then `popup.location.replace(authUrl)`. WKWebView has no scriptable
  // system-browser popup, so when WebKit denies the native window we return a
  // stand-in object whose `location.replace`/`assign` forward http(s) URLs to
  // the macOS default browser. Real in-app dsh:// popups (created natively)
  // are returned untouched.
  // -------------------------------------------------------------------------
  var nativeWindowOpen = window.open;
  var externalPopup = function (url) {
    var openInBrowser = function (nextUrl) {
      return invoke('shell_open_external', { url: String(nextUrl) });
    };
    return {
      closed: false,
      opener: null,
      focus: function () {},
      blur: function () {},
      close: function () {},
      postMessage: function () {},
      location: {
        replace: openInBrowser,
        assign: openInBrowser,
        href: String(url || ''),
      },
    };
  };
  window.open = function (url, target, features) {
    var win = null;
    try {
      win = nativeWindowOpen.call(window, url, target, features);
    } catch (error) {
      win = null;
    }
    if (win === null || win === undefined) {
      return externalPopup(url);
    }
    return win;
  };

  window.__DSH_MAC__ = {
    app: 'dsh-desktop',
    openExternal: function (url) {
      return invoke('shell_open_external', { url: String(url) });
    },
    showWindow: function () {
      return invoke('shell_show_window', {});
    },
  };

  void invoke('bridge_probe', {}).catch(function (error) {
    console.error('[dsh-desktop] bridge probe failed:', error);
  });
  // macOS 专属：Overlay 标题栏的 26px 拖拽区 + 边沿 resize hack。
  // Windows/Linux 使用系统装饰，交给 OS 窗口管理器，不劫持页面顶部。
  var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
  if (isMac) {
    installTitlebarDrag();
    installEdgeResize();
  }
})();