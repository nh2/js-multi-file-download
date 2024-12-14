// Adapted from:
//     https://github.com/ccvca/js-multi-file-download
//     MIT Licensed, Copyright 2023 - 2024 Christian von Arnim
// Modifications:
// * Support creation of sub directories (not only flat file hierarchies).
//   Required addition of `dirChain?` in the API.
// * URL-decoding (file names with spaces were incorrectly handled).
// * Updated to current TypeScript/eslint

export class MetadataError extends Error {}
export class DownloadError extends Error {}
export class FileExistError extends Error {}
export class InternalError extends Error {}
export class GeneralError extends Error {
    public innerException: any;
    constructor(error: string, innerException: any) {
        super(error);
        this.innerException = innerException;
    }
}

function getFilenameFromUrl(urlStr: string) {
    const url = new URL(urlStr, window.location.href);
    const pathname = url.pathname;
    const parts = pathname.split('/');
    const filename = parts.pop();
    return filename === undefined ? undefined : decodeURIComponent(filename); // came from `URL`, so was URL-encoded
}

interface DownloadFileOptions {
    progress?: (bytes: number, totalBytes?: number, precent?: number) => void;
    overrideExistingFile?: boolean;
}

export interface DownloadFileDesc {
    url: string; // string instead of URL so it can be given without origin, e.g. "myfile" or "/path/to/myfile"
    size?: number;
    dirChain?: string[];
    fileName?: string;
}

async function traverseDirChain(dirHandle: FileSystemDirectoryHandle, dirChain?: string[], options?: FileSystemGetDirectoryOptions) {
    let dh = dirHandle;
    for (const subDir of (dirChain ?? [])) {
        dh = await dh.getDirectoryHandle(subDir, options);
    }
    return dh;
}

export async function VerifyFileSize(dirHandle: FileSystemDirectoryHandle, reqFilename: string, size: number, dirChain?: string[]): Promise<boolean> {
    try {
        const parentDir = await traverseDirChain(dirHandle, dirChain);
        const fileHandle = await parentDir.getFileHandle(reqFilename);
        const file = await fileHandle.getFile();
        return file.size === size;
    }
    catch (ex) {
        return false;
    }
}

export enum DownloadFileRet {
    SKIPPED_EXIST = 1,
    DOWNLOADED = 2,
}

export async function DownloadFile(
    dirHandle: FileSystemDirectoryHandle,
    fileDesc: DownloadFileDesc,
    options: DownloadFileOptions = {}
): Promise<DownloadFileRet> {
    const filename = fileDesc.fileName === undefined ? getFilenameFromUrl(fileDesc.url) : fileDesc.fileName;
    if (filename === undefined) {
        throw new MetadataError("Could not determine filename.");
    }

    if (fileDesc.size !== undefined && await VerifyFileSize(dirHandle, filename, fileDesc.size, fileDesc.dirChain)) {
        return DownloadFileRet.SKIPPED_EXIST;
    }

    if (options.overrideExistingFile !== true) {
        try {
            const parentDir = await traverseDirChain(dirHandle, fileDesc.dirChain);
            await parentDir.getFileHandle(filename, { create: false }); // goal: throw if file exists
            throw new FileExistError(`File '${filename}' does already exist.`);
        } catch (ex: unknown) {
            const domEx: DOMException = ex as DOMException;
            if(ex instanceof FileExistError)
            {
                throw ex;
            }
            else if (domEx.name === undefined || domEx.name !== "NotFoundError") {
                throw new FileExistError(`File: '${filename}' does already exist. Exeption: ${domEx.message}`);
            }
        }
    }

    const abortController = new AbortController();
    const response = await fetch(fileDesc.url, { signal: abortController.signal });
    if (!response.ok) {
        throw new DownloadError(`Error while downloading: ${response.status} - ${response.statusText}`);
    }
    if (response.body === null) {
        throw new DownloadError(`No data`);
    }
    let responseStream = response.body;
    if (options.progress !== undefined) {
        let loadedBytes = 0;
        const totalBytesStr = response.headers.get("content-length");
        const totalBytesOrNan = Number.parseInt(totalBytesStr ?? '');
        const totalBytes = Number.isNaN(totalBytesOrNan) ? undefined : totalBytesOrNan;
        const progress = new TransformStream(
            {
                transform(chunk, controller) {
                    loadedBytes += chunk.length;
                    const precent = totalBytes !== undefined ? (loadedBytes / totalBytes) * 100 : undefined;
                    if (options.progress === undefined) {
                        return;
                    }
                    try {
                        options.progress(loadedBytes, totalBytes, precent);
                    }
                    catch (ex: any) {
                        // Exception in called funciton. Log and continue
                        console.log(ex);
                    }
                    controller.enqueue(chunk);
                }
            }
        );
        responseStream = responseStream.pipeThrough(progress);
    }

    try {
        const parentDir = await traverseDirChain(dirHandle, fileDesc.dirChain, { create: true });
        const fileHandle = await parentDir.getFileHandle(filename, { create: true });
        const writeable = await fileHandle.createWritable();
        await responseStream.pipeTo(writeable);
    } catch (ex: unknown) {
        // Abort possible pending request. (e.g. no permissions to create file, ...)
        abortController.abort();
        const errStr =
            (ex instanceof Error) ? ex.message :
            (typeof ex === "string") ? ex :
            "unknown error";
        throw new GeneralError(`Download of file ${filename} failed due to an exception: ${errStr}`, ex);
    }

    return DownloadFileRet.DOWNLOADED;
}


export interface ProgressState {
    // Taken from content-length header
    totalBytes?: number;
    // Only available, when content-length header is set
    percent?: number;
    // Bytes downloaded
    bytes: number;
}

export enum FileState {
    STARTED,
    COMPLETED_DOWNLOAD,
    SKIPPED_EXIST,
    ERROR
}

export type DlFilesOnStateChange = (url: string, update: { progress?: ProgressState, error?: Error, state?: FileState }) => void;

export interface DownloadFilesOptions {
    overrideExistingFile?: boolean;
    abortSignal?: AbortSignal;
    onStateUpdate?: DlFilesOnStateChange;
}


export async function DownloadFiles(dirHandle: FileSystemDirectoryHandle, files: DownloadFileDesc[], options?: DownloadFilesOptions) {
    if (options === undefined) {
        options = {};
    }
    const internalAbort = new AbortController();
    const abortController = options.abortSignal === undefined ? internalAbort.signal : options.abortSignal;
    /// \todo use parallel tasks? https://github.com/SGrondin/bottleneck#-using-asyncawait
    for (const dlFile of files) {
        if (abortController.aborted) {
            break;
        }
        const progressCallback = options.onStateUpdate === undefined ? undefined : (bytes: number, totalBytes?: number, percent?: number) => {
            options?.onStateUpdate?.(dlFile.url, {
                progress: {
                    bytes: bytes,
                    totalBytes: totalBytes,
                    percent: percent
                }
            });
        }
        const dlOpt: DownloadFileOptions = {
            overrideExistingFile: options.overrideExistingFile,
            progress: progressCallback,
        }
        options?.onStateUpdate?.(dlFile.url, {
            state: FileState.STARTED
        });
        try {
            /// \todo Forward abortController
            const ret = await DownloadFile(dirHandle, dlFile, dlOpt);
            switch (ret) {
                case DownloadFileRet.DOWNLOADED:
                    options?.onStateUpdate?.(dlFile.url, {
                        state: FileState.COMPLETED_DOWNLOAD
                    });
                    break;
                case DownloadFileRet.SKIPPED_EXIST:
                    options?.onStateUpdate?.(dlFile.url, {
                        state: FileState.SKIPPED_EXIST
                    });
                    break;
                default:
                    // Should never happen
                    throw new InternalError(`Unknown return value from download function: ${JSON.stringify(ret)} `);
            }

        } catch (ex: unknown) {
            const exError = ex as Error;
            options?.onStateUpdate?.(dlFile.url, {
                state: FileState.ERROR,
                error: exError
            });
        }
    }
}
