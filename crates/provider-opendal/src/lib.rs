mod local;
mod s3;

pub use local::OpenDalLocalBackend;
pub use s3::OpenDalS3Backend;

mod s3_admin;
pub use s3_admin::S3Admin;
