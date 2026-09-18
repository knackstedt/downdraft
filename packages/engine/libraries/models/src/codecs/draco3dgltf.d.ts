declare module "draco3dgltf" {
  interface DracoDecoderModule {
    decoder: any;
    Decoder: any;
    DecoderBuffer: any;
    Mesh: any;
    PointCloud: any;
    AttributeEnum: any;
    STATUS_OK: number;
    ERROR: number;
    INVALID_GEOMETRY_TYPE: number;
    TRIVIAL: number;
    POINT_CLOUD: number;
    TRIANGULAR_MESH: number;
    INVALID_ATTRIBUTE_TYPE: number;
    POSITION: number;
    NORMAL: number;
    COLOR: number;
    TEX_COORD: number;
    GENERIC: number;
    INVALID_DATA_TYPE: number;
    DT_FLOAT: number;
    DT_INT8: number;
    DT_UINT8: number;
    DT_INT16: number;
    DT_UINT16: number;
    DT_INT32: number;
    DT_UINT32: number;
    destroy(obj: any): void;
  }

  interface DracoModuleOptions {
    onModuleLoaded?: (module: DracoDecoderModule) => void;
    locateFile?: (path: string, prefix: string) => string;
  }

  export function createDecoderModule(options: DracoModuleOptions): Promise<DracoDecoderModule>;
  export function createEncoderModule(options: DracoModuleOptions): Promise<unknown>;
  export function setDracoDecoderPath(path: string): void;
}
