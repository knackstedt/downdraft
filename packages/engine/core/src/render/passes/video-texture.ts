export interface VideoTextureConfig {
  video: HTMLVideoElement | null;
  device: GPUDevice | null;
  format: GPUTextureFormat;
  maxResolution: number;
  autoplay: boolean;
  loop: boolean;
  muted: boolean;
}

export class VideoTextureSource {
  private config: VideoTextureConfig;
  private texture: GPUTexture | null = null;
  private view: GPUTextureView | null = null;
  private lastVideoTime: number = -1;

  constructor(config: Partial<VideoTextureConfig> & { device: GPUDevice }) {
    this.config = {
      video: null,
      format: "rgba8unorm",
      maxResolution: 1920,
      autoplay: true,
      loop: true,
      muted: true,
      ...config,
    };
  }

  setVideo(video: HTMLVideoElement): void {
    this.config.video = video;
    video.autoplay = this.config.autoplay;
    video.loop = this.config.loop;
    video.muted = this.config.muted;
  }

  update(): boolean {
    if (!this.config.video || !this.config.device) return false;
    const video = this.config.video;
    if (video.readyState < 2) return false;
    if (video.currentTime === this.lastVideoTime) return false;
    this.lastVideoTime = video.currentTime;

    const width = Math.min(video.videoWidth, this.config.maxResolution);
    const height = Math.min(video.videoHeight, this.config.maxResolution);

    if (!this.texture || this.texture.width !== width || this.texture.height !== height) {
      this.texture?.destroy();
      this.texture = this.config.device.createTexture({
        label: "video-texture",
        size: [width, height],
        format: this.config.format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
      });
      this.view = this.texture.createView();
    }

    this.config.device.queue.copyExternalImageToTexture(
      { source: video },
      { texture: this.texture },
      [width, height],
    );

    return true;
  }

  getTextureView(): GPUTextureView | null {
    return this.view;
  }

  getTexture(): GPUTexture | null {
    return this.texture;
  }

  destroy(): void {
    this.texture?.destroy();
    this.texture = null;
    this.view = null;
  }
}
