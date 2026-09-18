//! ACP (Agent Client Protocol) client: the editor side of the protocol,
//! spoken to each agent subprocess over stdio.

pub mod client;
pub mod transport;
pub mod updates;

pub use client::{AcpClient, AcpEvent, PermissionRequest};
pub use updates::SessionUpdate;
