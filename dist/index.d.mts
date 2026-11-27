import type { ConfigureHudOptions, ConfigureHudResult, ExportProfileOptions, ExportProfileResult, ImportProfileOptions, ImportProfileResult, RenderHudOptions, StatusLineData } from "./types.mjs";
export declare function configureHud(options?: ConfigureHudOptions): ConfigureHudResult;
export declare function exportProfile(options: ExportProfileOptions): ExportProfileResult;
export declare function importProfile(options: ImportProfileOptions): ImportProfileResult;
export declare function renderHudFromData(data: StatusLineData, options?: RenderHudOptions): string;
export * from "./types.mjs";
