use std::path::PathBuf;
use std::process::ExitCode;

use clai2_web_server::{build_router, AgentManager, ManagerConfig};
use tower_http::services::ServeDir;

const USAGE: &str = "\
clai2-web-server: manage CLAI coding agents from a browser

Usage: clai2-web-server [options]

Options:
  --repo <path>          repository agents work in (default: current directory)
  --port <port>          port to bind on 127.0.0.1 (default: 8787)
  --data-dir <path>      state directory (default: <repo>/.clai2-web)
  --worktrees-dir <path> where agent worktrees are created
                         (default: <data-dir>/worktrees)
  --max-agents <n>       concurrent agent cap (default: 100)
  --agent-cmd <cmd>      agent command line, whitespace-split
  --static-dir <path>    serve the built frontend from this directory
  --stub                 use the bundled deterministic stub agent

One of --agent-cmd or --stub is required.
";

struct Args {
    config: ManagerConfig,
    port: u16,
    static_dir: Option<PathBuf>,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut repo: Option<PathBuf> = None;
    let mut port: u16 = 8787;
    let mut data_dir: Option<PathBuf> = None;
    let mut worktrees_dir: Option<PathBuf> = None;
    let mut max_agents: usize = 100;
    let mut agent_command: Option<Vec<String>> = None;
    let mut static_dir: Option<PathBuf> = None;
    let mut stub = false;

    let mut iter = argv.iter();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| iter.next().cloned().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--repo" => repo = Some(PathBuf::from(value("--repo")?)),
            "--port" => {
                port = value("--port")?
                    .parse()
                    .map_err(|_| "--port must be a number".to_owned())?
            }
            "--data-dir" => data_dir = Some(PathBuf::from(value("--data-dir")?)),
            "--worktrees-dir" => worktrees_dir = Some(PathBuf::from(value("--worktrees-dir")?)),
            "--max-agents" => {
                max_agents = value("--max-agents")?
                    .parse()
                    .map_err(|_| "--max-agents must be a number".to_owned())?;
            }
            "--agent-cmd" => {
                agent_command = Some(value("--agent-cmd")?.split_whitespace().map(str::to_owned).collect());
            }
            "--static-dir" => static_dir = Some(PathBuf::from(value("--static-dir")?)),
            "--stub" => stub = true,
            other => return Err(format!("unknown argument: {other}\n\n{USAGE}")),
        }
    }

    let repo = match repo {
        Some(repo) => repo,
        None => std::env::current_dir().map_err(|err| err.to_string())?,
    };
    let agent_command = match (agent_command, stub) {
        (Some(command), _) if !command.is_empty() => command,
        (_, true) => {
            let mut stub_path = std::env::current_exe().map_err(|err| err.to_string())?;
            stub_path.set_file_name("stub-agent");
            vec![stub_path.to_string_lossy().into_owned()]
        }
        _ => return Err(format!("one of --agent-cmd or --stub is required\n\n{USAGE}")),
    };
    // Absolutize so git worktree paths and the agent cwd resolve to the same
    // place regardless of how the server was launched.
    let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
    let absolutize = |path: PathBuf| if path.is_absolute() { path } else { cwd.join(path) };
    let repo = absolutize(repo);
    let data_dir = absolutize(data_dir.unwrap_or_else(|| repo.join(".clai2-web")));
    let worktrees_dir = absolutize(worktrees_dir.unwrap_or_else(|| data_dir.join("worktrees")));
    Ok(Args {
        config: ManagerConfig {
            repo_root: repo,
            worktrees_dir,
            data_dir,
            agent_command,
            max_agents,
            github_api_base_url: "https://api.github.com".to_owned(),
        },
        port,
        static_dir,
    })
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(args) => args,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let manager = match AgentManager::new(args.config).await {
        Ok(manager) => manager,
        Err(err) => {
            eprintln!("failed to start: {err}");
            return ExitCode::FAILURE;
        }
    };
    manager.spawn_ci_poller();
    let mut router = build_router(manager);
    if let Some(static_dir) = args.static_dir {
        router = router.fallback_service(ServeDir::new(static_dir));
    }
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            eprintln!("failed to bind {addr}: {err}");
            return ExitCode::FAILURE;
        }
    };
    tracing::info!("listening on http://{addr}");
    match axum::serve(listener, router).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("server error: {err}");
            ExitCode::FAILURE
        }
    }
}
