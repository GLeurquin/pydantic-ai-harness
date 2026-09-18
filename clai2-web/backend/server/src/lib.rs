//! Web backend for managing CLAI coding agents over the Agent Client Protocol.

pub mod acp;
pub mod api;
pub mod approvals;
pub mod events;
pub mod manager;
pub mod model;
pub mod models;
pub mod store;
pub mod worktrees;

pub use api::build_router;
pub use manager::{AgentManager, ManagerConfig};
