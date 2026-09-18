/**
 * Generic blob storage interface.
 * Abstracts any S3-compatible or custom object store so games can
 * pull/push assets without coupling to a specific provider.
 */

export interface BlobObject {
  key: string;
  size: number;
  etag?: string;
  lastModified?: Date;
}

export interface BlobListOptions {
  prefix?: string;
  maxKeys?: number;
}

export interface BlobListResult {
  objects: BlobObject[];
  truncated: boolean;
  cursor?: string;
}

export interface BlobGetOptions {
  range?: { start: number; end: number };
}

export interface BlobPutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface BlobStoreConfig {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

/**
 * Cloud-agnostic blob storage interface.
 * Any provider (S3, MinIO, R2, B2, etc.) implements this.
 */
export interface BlobStore {
  get(key: string, options?: BlobGetOptions): Promise<Uint8Array>;
  put(key: string, data: Uint8Array, options?: BlobPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(options?: BlobListOptions): Promise<BlobListResult>;
  getMeta(key: string): Promise<BlobObject | null>;
}

export function parseBlobUri(uri: string): { bucket: string; key: string } | null {
  const match = uri.match(/^(?:s3|blob):\/\/([^/]+)\/?(.*)$/);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

export function makeBlobUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}
