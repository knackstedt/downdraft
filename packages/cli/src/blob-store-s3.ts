import type {
  BlobGetOptions,
  BlobListOptions,
  BlobListResult,
  BlobObject,
  BlobPutOptions,
  BlobStore,
  BlobStoreConfig,
} from "@downdraft/engine";

/**
 * S3-compatible blob store adapter.
 * Works with AWS S3, MinIO, Cloudflare R2, Backblaze B2, etc.
 * Uses the AWS SDK v3 S3 client with configurable endpoint.
 */
export class S3BlobStore implements BlobStore {
  private client: any;
  private bucket: string;

  constructor(config: BlobStoreConfig) {
    this.bucket = config.bucket;
    // Dynamic import to avoid hard dependency at module load
    // The CLI package declares @aws-sdk/client-s3 as a dependency
    const endpoint = config.endpoint;
    const region = config.region ?? "us-east-1";
    const forcePathStyle = config.forcePathStyle ?? true;

    // We use a lazy require pattern so the SDK is only loaded when needed
    const mod = require("@aws-sdk/client-s3");
    const S3Client = mod.S3Client;
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle,
      credentials: config.accessKeyId
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey!,
          }
        : undefined,
    });
  }

  async get(key: string, options?: BlobGetOptions): Promise<Uint8Array> {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Range: options?.range
        ? `bytes=${options.range.start}-${options.range.end}`
        : undefined,
    });
    const resp = await this.client.send(cmd);
    const buf = await resp.Body.transformToByteArray();
    return buf as Uint8Array;
  }

  async put(
    key: string,
    data: Uint8Array,
    options?: BlobPutOptions,
  ): Promise<void> {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: options?.contentType ?? "application/octet-stream",
      Metadata: options?.metadata,
    });
    await this.client.send(cmd);
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    const cmd = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    await this.client.send(cmd);
  }

  async exists(key: string): Promise<boolean> {
    const { HeadObjectCommand } = require("@aws-sdk/client-s3");
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async list(options?: BlobListOptions): Promise<BlobListResult> {
    const { ListObjectsV2Command } = require("@aws-sdk/client-s3");
    const cmd = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: options?.prefix,
      MaxKeys: options?.maxKeys ?? 1000,
      ContinuationToken: options?.cursor,
    });
    const resp = await this.client.send(cmd);
    const objects: BlobObject[] = (resp.Contents ?? []).map(
      (o: any) => ({
        key: o.Key,
        size: o.Size,
        etag: o.ETag?.replace(/"/g, ""),
        lastModified: o.LastModified ? new Date(o.LastModified) : undefined,
      }),
    );
    return {
      objects,
      truncated: resp.IsTruncated ?? false,
      cursor: resp.NextContinuationToken,
    };
  }

  async getMeta(key: string): Promise<BlobObject | null> {
    const { HeadObjectCommand } = require("@aws-sdk/client-s3");
    try {
      const resp = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        key,
        size: resp.ContentLength ?? 0,
        etag: resp.ETag?.replace(/"/g, ""),
        lastModified: resp.LastModified
          ? new Date(resp.LastModified)
          : undefined,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Create a BlobStore from a BlobStoreConfig.
 * Currently only S3-compatible, but extensible to other backends.
 */
export function createBlobStore(config: BlobStoreConfig): BlobStore {
  return new S3BlobStore(config);
}
