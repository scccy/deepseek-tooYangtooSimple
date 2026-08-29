use std::error::Error;

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build()?;
    for url in ["https://game.placegame.cn/api/client/bootstrap", "https://www.baidu.com"] {
        match client.get(url).send().await {
            Ok(r) => println!("OK {url} -> {}", r.status()),
            Err(e) => {
                println!("ERR {url}: {e}");
                let mut src: Option<&dyn Error> = Some(&e);
                while let Some(s) = src {
                    println!("   cause: {s}");
                    src = s.source();
                }
            }
        }
    }
    Ok(())
}
