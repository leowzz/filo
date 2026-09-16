mod local;
mod remote;
mod s3;

pub use local::OpenDalLocalBackend;
pub use remote::RemoteBackend;
pub use s3::OpenDalS3Backend;

mod s3_admin;
mod tos_stats;
pub use s3_admin::S3Admin;
