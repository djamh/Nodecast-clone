/**
 * Transcode Session Service
 * 
 * Manages HLS transcoding sessions with segment caching for VOD seeking.
 * Each session transcodes a source URL to HLS segments on disk.
 * 
 * Key features:
 * - Session-based transcoding with unique IDs
 * - HLS segment output for seeking support
 * - Segment caching for fast access
 * - Session persistence for recovery after restart
 * - Automatic cleanup of stale sessions
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const crypto = require('crypto');
const EventEmitter = require('events');
const hwDetect = require('./hwDetect');

// Session storage
const sessions = new Map();

// Cache directory for transcoded segments
const CACHE_DIR = path.join(process.cwd(), 'transcode-cache');

// Session settings
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SEGMENT_DURATION = 4; // seconds per HLS segment
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

/**
 * Generate a unique session ID
 */
function generateSessionId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') throw err;
    }
}

/**
 * TranscodeSession class
 * Manages a single transcoding session from source URL to HLS segments
 */
class TranscodeSession extends EventEmitter {
    constructor(url, options = {}) {
        super();
        this.id = generateSessionId();
        this.url = url;
        this.dir = path.join(CACHE_DIR, this.id);
        this.playlistPath = path.join(this.dir, 'stream.m3u8');
        this.variantPlaylistPattern = path.join(this.dir, '%v.m3u8');
        this.segmentFilenamePattern = path.join(this.dir, '%v_seg_%04d.ts');
        this.inputStreamInfo = null;
        this.process = null;
        this.sourceCachePath = path.join(this.dir, 'source-cache.mkv');
        this.sourceCacheProcess = null;
        this.subtitleProcesses = [];
        this.subtitleExtractionPromises = new Map();
        this.preloadedSubtitleTracks = [];
        this.segments = new Map(); // segment index -> { ready: boolean, path: string }
        this.status = 'pending'; // pending | starting | running | stopped | error
        this.error = null;
        this.startTime = Date.now();
        this.lastAccess = Date.now();
        this.options = {
            ffmpegPath: options.ffmpegPath || 'ffmpeg',
            userAgent: options.userAgent || 'Mozilla/5.0',
            seekOffset: options.seekOffset || 0,
            hwEncoder: options.hwEncoder || 'software',
            maxResolution: options.maxResolution || '1080p',
            quality: options.quality || 'medium',
            // Upscaling options
            upscaleEnabled: options.upscaleEnabled || false,
            upscaleMethod: options.upscaleMethod || 'hardware', // 'hardware' or 'software'
            upscaleTarget: options.upscaleTarget || '1080p',
            ...options
        };
    }

    /**
     * Start the transcoding process
     */
    async start() {
        if (this.status === 'running') {
            return;
        }

        this.status = 'starting';
        console.log(`[TranscodeSession ${this.id}] Starting session for: ${this.url}`);

        // Create session directory
        try {
            await fs.mkdir(this.dir, { recursive: true });
        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }

        
        // Build FFmpeg arguments for HLS output

        /*calling the method to create the list of audio output*/ 
                try {
                    this.inputStreamInfo = await this.probeInputStreams();

                    const audioCount = this.inputStreamInfo?.audioTracks?.length || 0;
                    const subtitleCount = this.inputStreamInfo?.subtitleTracks?.length || 0;

                    console.log(
                        `[TranscodeSession ${this.id}] Input probe: ${audioCount} audio track(s), ${subtitleCount} subtitle track(s)`
                    );

                    if (audioCount > 0) {
                        this.inputStreamInfo.audioTracks.forEach((track, i) => {
                            console.log(
                                `[TranscodeSession ${this.id}] Audio track ${i}: stream=${track.streamIndex}, lang=${track.language}`
                            );
                        });
                    }

                    if (subtitleCount > 0) {
                        this.inputStreamInfo.subtitleTracks.forEach((track, i) => {
                            console.log(
                                `[TranscodeSession ${this.id}] Subtitle track ${i}: stream=${track.streamIndex}, lang=${track.language}, codec=${track.codec}`
                            );
                        });
                    }
                } catch (err) {
                    console.warn(`[TranscodeSession ${this.id}] Input stream probe failed:`, err.message);
                    this.inputStreamInfo = { audioTracks: [], subtitleTracks: [] };
                }

               this.preloadedSubtitleTrack = null;
               this.preloadedSubtitleTracks = [];
                const args = this.buildFFmpegArgs();

                console.log(`[TranscodeSession ${this.id}] Command: ${this.options.ffmpegPath} ${args.join(' ')}`);

                try {
                    this.process = spawn(this.options.ffmpegPath, args, {
                        cwd: this.dir,
                        windowsHide: true
                    });

                    this.status = 'running';

                    // Handle stdout (should be empty for file output)
                    this.process.stdout.on('data', (data) => {
                        console.log(`[TranscodeSession ${this.id}] stdout: ${data}`);
                    });

                    // Handle stderr (FFmpeg progress/errors)
                    let stderrBuffer = '';
                    this.process.stderr.on('data', (data) => {
                        stderrBuffer += data.toString();
                        // Log periodically to avoid spam
                        const lines = stderrBuffer.split('\n');
                        if (lines.length > 1) {
                            lines.slice(0, -1).forEach(line => {
                                if (line.trim()) {
                                    console.log(`[FFmpeg ${this.id}] ${line}`);
                                }
                            });
                            stderrBuffer = lines[lines.length - 1];
                        }
                    });

                    // Handle process exit
                    this.process.on('exit', (code) => {
                        if (code === 0 || code === null) {
                            console.log(`[TranscodeSession ${this.id}] FFmpeg completed successfully`);
                            this.status = 'stopped';
                        } else if (code !== 255) { // 255 is often from SIGKILL
                            console.error(`[TranscodeSession ${this.id}] FFmpeg exited with code ${code}`);
                            this.status = 'error';
                            this.error = `FFmpeg exited with code ${code}`;
                        }
                        this.process = null;
                        this.emit('exit', code);
                    });

                    // Handle spawn errors
                    this.process.on('error', (err) => {
                        console.error(`[TranscodeSession ${this.id}] FFmpeg error:`, err);
                        this.status = 'error';
                        this.error = err.message;
                        this.emit('error', err);
                    });

                    this.startSourceCacheDownload();

                    const firstTrack = await this.preloadFirstSubtitleTrackFromLocalCache(45000, 120 * 1024 * 1024);
                    this.preloadedSubtitleTrack = firstTrack || null;
                    this.preloadedSubtitleTracks = firstTrack ? [firstTrack] : [];

            // Save session metadata
            await this.persist();

        } catch (err) {
            this.status = 'error';
            this.error = err.message;
            throw err;
        }
    }

    
    async probeInputStreams() {
        const ffmpegPath = this.options.ffmpegPath || 'ffmpeg';

        return new Promise((resolve) => {
            const args = [
                '-hide_banner',
                '-loglevel', 'info',
                '-user_agent', this.options.userAgent,
                '-probesize', '5000000',
                '-analyzeduration', '5000000',
                '-i', this.url,
                '-f', 'null',
                '-'
            ];



            /*Prepare to have a master playlist in the session*/ 
                const proc = spawn(ffmpegPath, args, { windowsHide: true });

                let stderr = '';
                let settled = false;

                const finish = () => {
                    if (settled) return;
                    settled = true;

                    const lines = stderr.split('\n');

                    const audioTracks = [];
                    const subtitleTracks = [];

                    for (const line of lines) {
                        const trimmed = line.trim();

                        if (trimmed.includes('Stream #') && trimmed.includes('Subtitle:')) {
                            const match = trimmed.match(/Stream #(\d+):(\d+)(?:\(([^)]+)\))?: Subtitle:\s*([^,]+)/);
                            if (match) {
                                subtitleTracks.push({
                                    programIndex: parseInt(match[1], 10),
                                    streamIndex: parseInt(match[2], 10),
                                    language: match[3] || 'und',
                                    codec: match[4].trim().toLowerCase(),
                                    raw: trimmed
                                });
                            }
                        }

                        if (trimmed.includes('Stream #') && trimmed.includes('Audio:')) {
                            const match = trimmed.match(/Stream #(\d+):(\d+)(?:\(([^)]+)\))?: Audio:/);
                            if (match) {
                                audioTracks.push({
                                    programIndex: parseInt(match[1], 10),
                                    streamIndex: parseInt(match[2], 10),
                                    language: match[3] || 'und',
                                    raw: trimmed
                                });
                            }
                        }
                    }

                    const uniqueAudioTracks = [];
                    const seenAudio = new Set();

                    for (const track of audioTracks) {
                        const key = `${track.programIndex}:${track.streamIndex}`;
                        if (!seenAudio.has(key)) {
                            seenAudio.add(key);
                            uniqueAudioTracks.push(track);
                        }
                    }

                    const uniqueSubtitleTracks = [];
                    const seenSubtitles = new Set();

                    for (const track of subtitleTracks) {
                        const key = `${track.programIndex}:${track.streamIndex}`;
                        if (!seenSubtitles.has(key)) {
                            seenSubtitles.add(key);
                            uniqueSubtitleTracks.push(track);
                        }
                    }

                    resolve({
                        audioTracks: uniqueAudioTracks,
                        subtitleTracks: uniqueSubtitleTracks
                    });

                };

                proc.stderr.on('data', (data) => {
                    stderr += data.toString();

                    // Once FFmpeg has printed stream info, we can stop early
                    if (stderr.includes('Stream #')) {
                        setTimeout(() => {
                            try { proc.kill('SIGKILL'); } catch {}
                            finish();
                        }, 500);
                    }
                });

                proc.on('error', () => finish());
                proc.on('exit', () => finish());

                setTimeout(() => {
                    try { proc.kill('SIGKILL'); } catch {}
                    finish();
                }, 8000);
            });
        }

    async startSidecarSubtitleExtractions() {
            const sidecarSubtitleTracks = this.getSidecarSubtitleTracks();

            if (!sidecarSubtitleTracks.length) {
                console.log(`[TranscodeSession ${this.id}] No sidecar subtitle tracks to extract`);
                return;
            }

            for (const subtitleTrack of sidecarSubtitleTracks) {
                const subtitlePath = path.join(this.dir, subtitleTrack.outputName);

                const args = [
                    '-hide_banner',
                    '-loglevel', 'warning',
                    '-user_agent', this.options.userAgent,
                    '-probesize', '32M',
                    '-analyzeduration', '8M',
                    '-reconnect', '1',
                    '-reconnect_at_eof', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_on_network_error', '1',
                    '-reconnect_on_http_error', '4xx,5xx',
                    '-reconnect_delay_max', '2',
                    '-i', this.url,
                    '-map', `0:${subtitleTrack.streamIndex}`,
                    '-c:s', 'webvtt',
                    '-f', 'webvtt',
                    subtitlePath
                ];

                console.log(
                    `[TranscodeSession ${this.id}] Starting sidecar subtitle extraction: stream=${subtitleTrack.streamIndex}, file=${subtitleTrack.outputName}`
                );

                try {
                    const proc = spawn(this.options.ffmpegPath, args, {
                        cwd: this.dir,
                        windowsHide: true
                    });

                    this.subtitleProcesses.push(proc);

                    proc.stderr.on('data', (data) => {
                        const msg = data.toString().trim();
                        if (msg) {
                            console.log(`[FFmpeg subtitle ${this.id}] ${msg}`);
                        }
                    });

                    proc.on('exit', (code) => {
                        console.log(
                            `[TranscodeSession ${this.id}] Subtitle extraction exited for ${subtitleTrack.outputName} with code ${code}`
                        );
                    });

                    proc.on('error', (err) => {
                        console.error(
                            `[TranscodeSession ${this.id}] Subtitle extraction error for ${subtitleTrack.outputName}:`,
                            err
                        );
                    });
                } catch (err) {
                    console.error(
                        `[TranscodeSession ${this.id}] Failed to start subtitle extraction for ${subtitleTrack.outputName}:`,
                        err
                    );
                }
            }
        }

    async ensureSidecarSubtitleReady(subtitleFileName) {
    const subtitleTrack = this.getSidecarSubtitleTracks().find(
        (track) => track.outputName === subtitleFileName
    );

    if (!subtitleTrack) {
        return false;
    }

    const subtitlePath = path.join(this.dir, subtitleTrack.outputName);

    const waitForExistingSubtitle = async (timeoutMs = 4000) => {
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            try {
                const content = await fs.readFile(subtitlePath, 'utf8');
                const normalized = content ? content.trim() : '';

                if (
                    normalized &&
                    normalized.includes('WEBVTT') &&
                    /-->/.test(normalized) &&
                    normalized.length > 20
                ) {
                    return true;
                }
            } catch {}

            await new Promise(resolve => setTimeout(resolve, 250));
        }

        return false;
    };

    if (await waitForExistingSubtitle(4000)) {
        return true;
    }

    const existingExtraction = this.subtitleExtractionPromises.get(subtitleFileName);
    if (existingExtraction) {
        return existingExtraction;
    }

    const waitForLocalCache = async (timeoutMs = 45000, minSizeBytes = 120 * 1024 * 1024) => {
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const cacheInfo = await this.getSourceCacheInfo();
            if (cacheInfo.exists && cacheInfo.size >= minSizeBytes) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        return false;
    };

    const hasLocalCache = await waitForLocalCache(45000, 120 * 1024 * 1024);

    const extractionPromise = new Promise((resolve) => {
        if (!hasLocalCache) {
            console.log(
                `[TranscodeSession ${this.id}] Subtitle extraction timed out waiting for local cache: ${subtitleTrack.outputName}`
            );
            return resolve(false);
        }

        const args = [
            '-y',
            '-hide_banner',
            '-loglevel', 'warning',
            '-i', this.sourceCachePath,
            '-map', `0:${subtitleTrack.streamIndex}`,
            '-c:s', 'webvtt',
            '-f', 'webvtt',
            subtitlePath
        ];

        console.log(
            `[TranscodeSession ${this.id}] Extracting subtitle on demand: stream=${subtitleTrack.streamIndex}, file=${subtitleTrack.outputName}, source=local-cache`
        );

        let settled = false;
        const finish = async (ok) => {
            if (settled) return;
            settled = true;

            if (ok) {
                try {
                    await fs.access(subtitlePath);
                    return resolve(true);
                } catch {}
            }

            resolve(false);
        };

        try {
            const proc = spawn(this.options.ffmpegPath, args, {
                cwd: this.dir,
                windowsHide: true
            });

            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    console.log(`[FFmpeg subtitle ${this.id}] ${msg}`);
                }
            });

            proc.on('error', () => finish(false));
            proc.on('exit', (code) => {
                finish(code === 0 || code === null);
            });

            setTimeout(() => finish(false), 45000);
        } catch (err) {
            console.error(
                `[TranscodeSession ${this.id}] Failed to extract subtitle on demand for ${subtitleTrack.outputName}:`,
                err
            );
            finish(false);
        }
      });

            this.subtitleExtractionPromises.set(subtitleFileName, extractionPromise);

            extractionPromise.finally(() => {
                this.subtitleExtractionPromises.delete(subtitleFileName);
            });

            return extractionPromise;
        }

    async preloadFirstSubtitleTrack(timeoutMs = 20000) {
        const subtitleTrack = this.getTextSubtitleTracks()[0];
        if (!subtitleTrack) {
            console.log(`[TranscodeSession ${this.id}] No text subtitle track available for preload`);
            return null;
        }

        const subtitlePath = path.join(this.dir, 'sub_0.vtt');

        try {
            await fs.rm(subtitlePath, { force: true });
        } catch {}

        return new Promise((resolve) => {
            const args = [
                '-y',
                '-hide_banner',
                '-loglevel', 'warning',
                '-user_agent', this.options.userAgent,
                '-probesize', '32M',
                '-analyzeduration', '8M',
                '-reconnect', '1',
                '-reconnect_at_eof', '1',
                '-reconnect_streamed', '1',
                '-reconnect_on_network_error', '1',
                '-reconnect_on_http_error', '4xx,5xx',
                '-reconnect_delay_max', '2',
                '-i', this.url,
                '-map', `0:${subtitleTrack.streamIndex}`,
                '-c:s', 'webvtt',
                '-f', 'webvtt',
                subtitlePath
            ];

            console.log(
                `[TranscodeSession ${this.id}] Preloading first subtitle track before playback: stream=${subtitleTrack.streamIndex}, file=sub_0.vtt`
            );

            let settled = false;

            const finish = async (ok) => {
                if (settled) return;
                settled = true;

                if (ok) {
                    try {
                        const content = await fs.readFile(subtitlePath, 'utf8');
                        if (content && content.includes('WEBVTT')) {
                            console.log(
                                `[TranscodeSession ${this.id}] First subtitle preload succeeded (length=${content.length})`
                            );
                            return resolve({
                                index: 0,
                                streamIndex: subtitleTrack.streamIndex,
                                language: subtitleTrack.language || 'und',
                                codec: subtitleTrack.codec,
                                label: (subtitleTrack.language || 'und').toUpperCase(),
                                outputName: 'sub_0.vtt'
                            });
                        }
                    } catch {}
                }

                console.log(`[TranscodeSession ${this.id}] First subtitle preload did not complete in time`);
                resolve(null);
            };

            try {
                const proc = spawn(this.options.ffmpegPath, args, {
                    cwd: this.dir,
                    windowsHide: true
                });

                proc.stderr.on('data', (data) => {
                    const msg = data.toString().trim();
                    if (msg) {
                        console.log(`[FFmpeg subtitle preload ${this.id}] ${msg}`);
                    }
                });

                proc.on('error', () => finish(false));
                proc.on('exit', (code) => finish(code === 0 || code === null));

                setTimeout(() => {
                    try { proc.kill('SIGKILL'); } catch {}
                    finish(false);
                }, timeoutMs);
            } catch (err) {
                console.error(
                    `[TranscodeSession ${this.id}] Failed to start subtitle preload:`,
                    err
                );
                finish(false);
            }
        });
    }

    startSourceCacheDownload() {
        if (this.sourceCacheProcess) {
            return;
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', this.options.userAgent,
            '-probesize', '5000000',
            '-analyzeduration', '5000000',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '3',
            '-i', this.url,
            '-map', '0',
            '-c', 'copy',
            '-f', 'matroska',
            this.sourceCachePath
        ];

        console.log(
            `[TranscodeSession ${this.id}] Starting local source cache download: ${this.sourceCachePath}`
        );

        try {
            const proc = spawn(this.options.ffmpegPath, args, {
                cwd: this.dir,
                windowsHide: true
            });

            this.sourceCacheProcess = proc;

            const sizeLogInterval = setInterval(async () => {
                const info = await this.getSourceCacheInfo();
                if (info.exists) {
                    console.log(
                        `[TranscodeSession ${this.id}] Source cache size: ${info.size} bytes`
                    );
                }
            }, 5000);

            proc.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) {
                    console.log(`[FFmpeg source-cache ${this.id}] ${msg}`);
                }
            });

            proc.on('exit', (code, signal) => {
                console.log(
                    `[TranscodeSession ${this.id}] Source cache download exited with code=${code} signal=${signal}`
                );
                if (this.sourceCacheProcess === proc) {
                    this.sourceCacheProcess = null;
                }
                clearInterval(sizeLogInterval);
            });

            proc.on('error', (err) => {
                console.error(
                    `[TranscodeSession ${this.id}] Source cache download error:`,
                    err
                );
                if (this.sourceCacheProcess === proc) {
                    this.sourceCacheProcess = null;
                }
                clearInterval(sizeLogInterval);
            });
        } catch (err) {
            console.error(
                `[TranscodeSession ${this.id}] Failed to start source cache download:`,
                err
            );
        }
    }

        stopSourceCacheDownload() {
            if (!this.sourceCacheProcess) {
                return;
            }

            console.log(`[TranscodeSession ${this.id}] Stopping source cache download after subtitle preload`);

            try {
                this.sourceCacheProcess.kill('SIGTERM');
            } catch {}

            setTimeout(() => {
                if (this.sourceCacheProcess) {
                    try {
                        this.sourceCacheProcess.kill('SIGKILL');
                    } catch {}
                }
            }, 2000);
        }

    async getSourceCacheInfo() {
        try {
            const stats = await fs.stat(this.sourceCachePath);
            return {
                exists: true,
                size: stats.size
            };
        } catch {
            return {
                exists: false,
                size: 0
            };
        }
    }

    async preloadFirstSubtitleTrackFromLocalCache(timeoutMs = 15000, minSizeBytes = 180 * 1024 * 1024) {
        const subtitleTrack = this.getTextSubtitleTracks()[0];
        if (!subtitleTrack) {
            console.log(`[TranscodeSession ${this.id}] No text subtitle track available for local-cache preload`);
            return null;
        }

        const subtitlePath = path.join(this.dir, 'sub_0.vtt');
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
            const cacheInfo = await this.getSourceCacheInfo();

            if (cacheInfo.exists && cacheInfo.size >= minSizeBytes) {
                console.log(
                    `[TranscodeSession ${this.id}] Trying subtitle preload from local cache at ${cacheInfo.size} bytes`
                );

                try {
                    await fs.rm(subtitlePath, { force: true });
                } catch {}

                const args = [
                    '-hide_banner',
                    '-loglevel', 'warning',
                    '-i', this.sourceCachePath,
                    '-map', `0:${subtitleTrack.streamIndex}`,
                    '-c:s', 'webvtt',
                    '-f', 'webvtt',
                    subtitlePath
                ];

                try {
                    await new Promise((resolve) => {
                        const proc = spawn(this.options.ffmpegPath, args, {
                            cwd: this.dir,
                            windowsHide: true
                        });

                        let settled = false;
                        const finish = () => {
                            if (settled) return;
                            settled = true;
                            resolve();
                        };

                        proc.stderr.on('data', (data) => {
                            const msg = data.toString().trim();
                            if (msg) {
                                console.log(`[FFmpeg subtitle local-cache ${this.id}] ${msg}`);
                            }
                        });

                        proc.on('error', finish);
                        proc.on('exit', finish);

                        setTimeout(() => {
                            try { proc.kill('SIGKILL'); } catch {}
                            finish();
                        }, 8000);
                    });

                    try {
                        const content = await fs.readFile(subtitlePath, 'utf8');
                        const normalized = content ? content.trim() : '';

                        if (
                            normalized &&
                            normalized.includes('WEBVTT') &&
                            normalized.length > 20 &&
                            /-->/.test(normalized)
                        ) {
                            console.log(
                                `[TranscodeSession ${this.id}] Local-cache subtitle preload succeeded (length=${content.length})`
                            );

                            return {
                                index: 0,
                                streamIndex: subtitleTrack.streamIndex,
                                language: subtitleTrack.language || 'und',
                                codec: subtitleTrack.codec,
                                label: (subtitleTrack.language || 'und').toUpperCase(),
                                outputName: 'sub_0.vtt'
                            };
                        }

                        console.log(
                            `[TranscodeSession ${this.id}] Local-cache subtitle preload produced incomplete subtitle output (length=${normalized.length})`
                        );
                    } catch {}
                } catch (err) {
                    console.error(
                        `[TranscodeSession ${this.id}] Local-cache subtitle preload failed:`,
                        err
                    );
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        console.log(`[TranscodeSession ${this.id}] Local-cache subtitle preload did not complete in time`);
        return null;
    }

    async preloadSubtitleTracksFromLocalCache(timeoutMs = 30000, minSizeBytes = 150 * 1024 * 1024) {
        const subtitleTracks = this.getTextSubtitleTracks();

        if (!subtitleTracks.length) {
            console.log(`[TranscodeSession ${this.id}] No text subtitle tracks available for local-cache preload`);
            return [];
        }

        const start = Date.now();
        const readyTracks = [];
        const completedIndexes = new Set();

        while (Date.now() - start < timeoutMs) {
            const cacheInfo = await this.getSourceCacheInfo();

            if (cacheInfo.exists && cacheInfo.size >= minSizeBytes) {
                console.log(
                    `[TranscodeSession ${this.id}] Trying multi-subtitle preload from local cache at ${cacheInfo.size} bytes`
                );

                for (let i = 0; i < subtitleTracks.length; i++) {
                    if (completedIndexes.has(i)) continue;

                    const subtitleTrack = subtitleTracks[i];
                    const outputName = `sub_${i}.vtt`;
                    const subtitlePath = path.join(this.dir, outputName);

                    try {
                        await fs.rm(subtitlePath, { force: true });
                    } catch {}

                    const args = [
                        '-hide_banner',
                        '-loglevel', 'warning',
                        '-i', this.sourceCachePath,
                        '-map', `0:${subtitleTrack.streamIndex}`,
                        '-c:s', 'webvtt',
                        '-f', 'webvtt',
                        subtitlePath
                    ];

                    try {
                        await new Promise((resolve) => {
                            const proc = spawn(this.options.ffmpegPath, args, {
                                cwd: this.dir,
                                windowsHide: true
                            });

                            let settled = false;
                            const finish = () => {
                                if (settled) return;
                                settled = true;
                                resolve();
                            };

                            proc.stderr.on('data', (data) => {
                                const msg = data.toString().trim();
                                if (msg) {
                                    console.log(`[FFmpeg subtitle local-cache ${this.id}] ${msg}`);
                                }
                            });

                            proc.on('error', finish);
                            proc.on('exit', finish);

                            setTimeout(() => {
                                try { proc.kill('SIGKILL'); } catch {}
                                finish();
                            }, 8000);
                        });

                        try {
                            const content = await fs.readFile(subtitlePath, 'utf8');
                            const normalized = content ? content.trim() : '';

                            if (
                                normalized &&
                                normalized.includes('WEBVTT') &&
                                normalized.length > 20 &&
                                /-->/.test(normalized)
                            ) {
                                readyTracks.push({
                                    index: i,
                                    streamIndex: subtitleTrack.streamIndex,
                                    language: subtitleTrack.language || 'und',
                                    codec: subtitleTrack.codec,
                                    label: (subtitleTrack.language || 'und').toUpperCase(),
                                    outputName
                                });

                                completedIndexes.add(i);

                                console.log(
                                    `[TranscodeSession ${this.id}] Local-cache subtitle preload succeeded for ${outputName} (length=${content.length})`
                                );
                            } else {
                                console.log(
                                    `[TranscodeSession ${this.id}] Local-cache subtitle preload produced incomplete output for ${outputName} (length=${normalized.length})`
                                );
                            }
                        } catch {}
                    } catch (err) {
                        console.error(
                            `[TranscodeSession ${this.id}] Local-cache subtitle preload failed for ${outputName}:`,
                            err
                        );
                    }
                }

                if (readyTracks.length === subtitleTracks.length) {
                    return readyTracks;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (readyTracks.length > 0) {
            console.log(
                `[TranscodeSession ${this.id}] Multi-subtitle preload timed out, returning partial results (${readyTracks.length}/${subtitleTracks.length})`
            );
            return readyTracks;
        }

        console.log(`[TranscodeSession ${this.id}] Multi-subtitle local-cache preload did not complete in time`);
        return [];
    }

    /*Check if the method to use multiple audio is needed*/ 
    shouldUseMultiAudioHls() {
    const audioTracks = this.inputStreamInfo?.audioTracks || [];
    return audioTracks.length > 1;
    }

    getTextSubtitleTracks() {
        const subtitleTracks = this.inputStreamInfo?.subtitleTracks || [];
        const unsupportedCodecs = new Set([
            'hdmv_pgs_subtitle',
            'pgssub',
            'dvd_subtitle',
            'xsub'
        ]);

        return subtitleTracks.filter(track => !unsupportedCodecs.has(track.codec));
    }

    shouldUseSubtitleHls() {
        return this.getTextSubtitleTracks().length > 0;
    }

    getSidecarSubtitleTracks() {
        return this.getTextSubtitleTracks().map((track, i) => ({
            ...track,
            outputName: `sub_${i}.vtt`
        }));
    }


    /**
     * Build FFmpeg arguments for HLS output with optional GPU encoding
     */
    buildFFmpegArgs() {
        const segmentPattern = path.join(this.dir, 'seg%04d.m4s');
        const videoMode = this.options.videoMode || 'encode';
        const useMultiAudioHls = this.shouldUseMultiAudioHls();
        const textSubtitleTracks = this.getTextSubtitleTracks();
        const sidecarSubtitleTracks = this.getSidecarSubtitleTracks();
        const useSubtitleHls = textSubtitleTracks.length > 0;

        // Resolve 'auto' encoder to detected hardware, fallback to software
        let encoder = this.options.hwEncoder || 'software';
        if (encoder === 'auto') {
            const hwCaps = hwDetect.getCapabilities();
            const recommendedEncoder = hwCaps?.recommended || 'software';

            encoder = recommendedEncoder === 'amf' ? 'software' : recommendedEncoder;

            console.log(
                `[TranscodeSession ${this.id}] Auto encoder resolved to: ${recommendedEncoder}`
            );
        }

        const args = [
            '-hide_banner',
            '-loglevel', 'warning',
            '-user_agent', this.options.userAgent,
        ];
        
        if (useMultiAudioHls) {
            console.log(
                `[TranscodeSession ${this.id}] Multi-audio HLS mode requested for ${this.inputStreamInfo.audioTracks.length} audio tracks`
            );
        }

        // Add hardware acceleration input options based on encoder (only if encoding)
        if (videoMode === 'encode') {
            this.addHwAccelInputArgs(args, encoder);
        }

        // Input options (common)
        args.push(
            '-probesize', '32M',
            '-analyzeduration', '8M',
            '-fflags', '+genpts+discardcorrupt',
            '-err_detect', 'ignore_err',
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_on_network_error', '1',
            '-reconnect_on_http_error', '4xx,5xx',
            '-reconnect_delay_max', '2'
        );

        args.push('-i', this.url);

        // Add seek offset if specified (as output option to avoid Range requests)
        if (this.options.seekOffset > 0) {
            args.push('-ss', String(this.options.seekOffset));
        }

        // Map streams
        args.push('-map', '0:v:0');

        if (useMultiAudioHls) {
            const audioTracks = this.inputStreamInfo?.audioTracks || [];
            audioTracks.forEach((track, i) => {
                args.push('-map', `0:a:${i}`);
            });

        } else {
            args.push('-map', '0:a?');
        }

        // Add video encoder and filters based on selected encoder OR copy
        if (videoMode === 'copy') {
            args.push('-c:v', 'copy');

            // Critical for MKV/MP4 -> TS copy: Convert bitstream from AVCC/HVCC to Annex B
            if (this.options.videoCodec === 'hevc' || this.options.videoCodec === 'h265') {
                args.push('-bsf:v', 'hevc_mp4toannexb');
            } else if (this.options.videoCodec === 'h264' || this.options.videoCodec === 'avc') {
                args.push('-bsf:v', 'h264_mp4toannexb');
            } else {
                // Fallback (e.g. unknown codec), try strict extraction
                args.push('-bsf:v', 'dump_extra');
            }
        } else {
            this.addVideoEncoderArgs(args, encoder);
        }

        /*Early return in case of multi audio*/ 
        if (useMultiAudioHls) {
            console.log(`[TranscodeSession ${this.id}] Building master-playlist HLS with alternate audio`);

            // Keep video settings from above, but force all audio tracks to AAC stereo
            args.push(
                '-c:a', 'aac',
                '-ac:a', '2',
                '-ar:a', '48000',
                '-b:a', '192k'
            );


            const audioTracks = this.inputStreamInfo?.audioTracks || [];
            const audioEntries = audioTracks.map((track, i) => {
                const lang = (track.language || 'und').toLowerCase();
                const safeName = lang === 'und' ? `audio${i + 1}` : lang;
                const defaultFlag = i === 0 ? 'yes' : 'no';
                return `a:${i},agroup:audio,language:${lang},name:${safeName},default:${defaultFlag}`;
            });

            const varStreamMap = [
                'v:0,agroup:audio',
                ...audioEntries
            ].join(' ');

            console.log(`[TranscodeSession ${this.id}] HLS var_stream_map (audio only): ${varStreamMap}`);

            args.push(
            '-master_pl_name', 'stream.m3u8',
            '-var_stream_map', varStreamMap,
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', '0',
            '-hls_flags', 'independent_segments+append_list',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', this.segmentFilenamePattern,
            this.variantPlaylistPattern
        );

        

        return args;
        }

        // Audio: Apply mix preset
        const audioCodec = this.options.audioCodec?.toLowerCase() || 'unknown';
        const audioChannels = this.options.audioChannels || 0;
        const audioMixPreset = this.options.audioMixPreset || 'auto';
        const isStereoAac = audioCodec.includes('aac') && audioChannels === 2;

        // Define pan filter presets for 5.1 -> Stereo downmix
        const AUDIO_MIX_FILTERS = {
            // ITU-R BS.775 Standard: Mathematically balanced, transparent
            itu: 'pan=stereo|FL=FL+0.707*FC+0.707*BL+0.5*LFE|FR=FR+0.707*FC+0.707*BR+0.5*LFE',
            // Night Mode: Heavy dialogue boost, reduced bass/surrounds for quiet viewing
            night: 'pan=stereo|FL=0.5*FL+1.2*FC+0.3*BL+0.1*LFE|FR=0.5*FR+1.2*FC+0.3*BR+0.1*LFE',
            // Cinematic: Wide soundstage, immersive (original "dialogue boost" mix)
            cinematic: 'pan=stereo|FL=FC+0.80*FL+0.60*BL+0.5*LFE|FR=FC+0.80*FR+0.60*BR+0.5*LFE'
        };

        if (audioMixPreset === 'passthrough') {
            // Passthrough: Always copy audio, no processing
            console.log(`[TranscodeSession ${this.id}] Audio: Passthrough (copy)`);
            args.push('-c:a', 'copy');
        } else if (audioMixPreset === 'auto' && isStereoAac) {
            // Auto + Stereo AAC source: Smart copy
            console.log(`[TranscodeSession ${this.id}] Audio: Auto (Smart Copy) - Source is Stereo AAC`);
            args.push('-c:a', 'copy');
        } else {
            // Transcode to AAC with selected mix preset (default to ITU for 'auto')
            const mixPreset = (audioMixPreset === 'auto') ? 'itu' : audioMixPreset;
            const panFilter = AUDIO_MIX_FILTERS[mixPreset] || AUDIO_MIX_FILTERS.itu;

            console.log(`[TranscodeSession ${this.id}] Audio: ${mixPreset.toUpperCase()} mix (${audioCodec} ${audioChannels}ch -> Stereo AAC)`);
            args.push(
                '-c:a', 'aac',
                '-ar', '48000',
                '-b:a', '192k',
                '-af', `${panFilter},aresample=async=1`
            );
        }

        // HLS output options
        args.push(
            '-f', 'hls',
            '-hls_time', String(SEGMENT_DURATION),
            '-hls_list_size', '0',
            '-hls_flags', 'independent_segments+append_list',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.dir, 'seg%04d.ts'),
            this.playlistPath
        );


        return args;
    }



    /**
     * Add hardware acceleration input arguments
     */
    addHwAccelInputArgs(args, encoder) {
        switch (encoder) {
            case 'nvenc':
                // NVIDIA CUDA/NVDEC hardware decoding
                args.push(
                    '-hwaccel', 'cuda',
                    '-hwaccel_output_format', 'cuda'
                );
                break;
            case 'vaapi':
                // VAAPI hardware decoding (Linux)
                args.push(
                    '-hwaccel', 'vaapi',
                    '-hwaccel_device', '/dev/dri/renderD128',
                    '-hwaccel_output_format', 'vaapi'
                );
                break;
            case 'qsv':
                // Intel QuickSync hardware decoding
                args.push(
                    '-hwaccel', 'qsv',
                    '-hwaccel_output_format', 'qsv'
                );
                break;
            case 'amf':
                // AMD AMF (no hwaccel input, AMF is encode-only)
                // Decode on CPU, encode on GPU
                break;
            case 'software':
            case 'auto':
            default:
                // No hardware acceleration for input
                break;
        }
    }

    /**
     * Add video encoder arguments based on selected encoder
     */
    addVideoEncoderArgs(args, encoder) {
        const resolution = this.getTargetHeight();
        const quality = this.options.quality || 'medium';

        // Quality presets mapping
        const qualityPresets = {
            'high': { nvenc: 18, vaapi: 18, qsv: 18, amf: 18, software: 18 },
            'medium': { nvenc: 24, vaapi: 24, qsv: 24, amf: 24, software: 23 },
            'low': { nvenc: 30, vaapi: 30, qsv: 30, amf: 30, software: 28 }
        };
        const qp = qualityPresets[quality] || qualityPresets.medium;

        switch (encoder) {
            case 'nvenc':
                this.addNvencEncoderArgs(args, resolution, qp.nvenc);
                break;
            case 'amf':
                this.addAmfEncoderArgs(args, resolution, qp.amf);
                break;
            case 'vaapi':
                this.addVaapiEncoderArgs(args, resolution, qp.vaapi);
                break;
            case 'qsv':
                this.addQsvEncoderArgs(args, resolution, qp.qsv);
                break;
            case 'software':
            case 'auto':
            default:
                this.addSoftwareEncoderArgs(args, resolution, qp.software);
                break;
        }
    }

    /**
     * Get target height based on maxResolution or upscaleTarget setting
     * When upscaling is enabled, uses the upscaleTarget resolution.
     * Otherwise, uses maxResolution to cap the output.
     */
    getTargetHeight() {
        const resolutionMap = {
            '4k': 2160,
            '1080p': 1080,
            '720p': 720,
            '480p': 480
        };

        if (this.options.upscaleEnabled) {
            const target = resolutionMap[this.options.upscaleTarget] || 1080;
            console.log(`[TranscodeSession ${this.id}] Upscale target height: ${target}p`);
            return target;
        }

        let target = resolutionMap[this.options.maxResolution] || 1080;

        if (this.options.hwEncoder === 'amf' && target > 1080) {
            console.log(`[TranscodeSession ${this.id}] Capping AMF target height to 1080p for compatibility`);
            target = 1440;
        }

        return target;
    }

    /**
     * Build scale filter string based on encoder and upscaling settings
     * @param {string} encoder - The encoder being used
     * @param {number} height - Target height
     */
    buildScaleFilter(encoder, height) {
        const useUpscale = this.options.upscaleEnabled;
        const upscaleMethod = this.options.upscaleMethod || 'hardware';

        // Log upscaling status
        if (useUpscale) {
            console.log(`[TranscodeSession ${this.id}] Upscaling: ${upscaleMethod} method to ${height}p`);
        }

        // Hardware scaling filters (for both upscale and downscale)
        if (upscaleMethod === 'hardware' || !useUpscale) {
            switch (encoder) {
                case 'nvenc':
                    // NVIDIA CUDA scaling with Lanczos
                    // Force nv12 (8-bit) output to handle 10-bit inputs (fixes "10 bit encode not supported")
                    return `scale_cuda=-2:${height}:interp_algo=lanczos:format=nv12`;
                case 'vaapi':
                    return `scale_vaapi=w=-2:h=${height}:format=nv12`;
                case 'qsv':
                    return `scale_qsv=w=-2:h=${height}:format=nv12`;
                case 'amf':
                    // AMF uses CPU decode, so use software scale
                    return useUpscale ? `scale=-2:${height}:flags=lanczos` : `scale=-2:${height}`;
                case 'software':
                default:
                    return useUpscale ? `scale=-2:${height}:flags=lanczos` : `scale=-2:${height}`;
            }
        }

        // Software Lanczos scaling (high quality, slower)
        return `scale=-2:${height}:flags=lanczos`;
    }

    /**
     * NVIDIA NVENC encoder arguments
     */
    addNvencEncoderArgs(args, height, qp) {
        // Video filter for scaling on GPU
        args.push('-vf', this.buildScaleFilter('nvenc', height));

        // NVENC encoder with quality settings
        // Using portable options that work across FFmpeg builds
        args.push(
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',           // Balanced preset (p1=fastest, p7=best)
            '-rc', 'constqp',          // Constant QP mode
            '-qp', String(qp),
            '-bf', '3'                 // B-frames for better compression
        );
    }

    /**
     * AMD AMF encoder arguments
     */
    addAmfEncoderArgs(args, height, qp) {
        // CPU decoding + software scale + AMF encode
        args.push('-vf', this.buildScaleFilter('amf', height));

        args.push(
            '-c:v', 'h264_amf',
            '-quality', 'quality',     // Quality preset
            '-rc', 'cqp',              // Constant QP
            '-qp_i', String(qp),
            '-qp_p', String(qp + 2),
            '-qp_b', String(qp + 4),
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * VAAPI encoder arguments (Linux)
     */
    addVaapiEncoderArgs(args, height, qp) {
        // VAAPI filter chain:
        // 1. scale_vaapi to resize on GPU
        // 2. Ensure output format is nv12 for maximum encoder compatibility
        // The format is handled automatically when using -hwaccel_output_format vaapi
        args.push('-vf', this.buildScaleFilter('vaapi', height));

        // VAAPI encoder with quality setting
        // Note: -global_quality is the portable way to set quality for VAAPI
        args.push(
            '-c:v', 'h264_vaapi',
            '-profile:v', 'main',      // Use main profile for compatibility
            '-global_quality', String(qp),
            '-bf', '3',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Intel QuickSync encoder arguments
     */
    addQsvEncoderArgs(args, height, qp) {
        // Scale on QSV
        args.push('-vf', this.buildScaleFilter('qsv', height));

        args.push(
            '-c:v', 'h264_qsv',
            '-preset', 'medium',
            '-global_quality', String(qp),
            '-look_ahead', '1',
            '-look_ahead_depth', '40',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility
        );
    }

    /**
     * Software encoder arguments (fallback)
     */
    addSoftwareEncoderArgs(args, height, crf) {
        // Software scaling (use Lanczos for upscaling if enabled)
        args.push('-vf', this.buildScaleFilter('software', height));

        args.push(
            '-c:v', 'libx264',
            '-preset', 'veryfast',     // Fast for real-time
            '-crf', String(crf),
            '-profile:v', 'high',
            '-pix_fmt', 'yuv420p'      // Force 8-bit output for compatibility (fixes 10-bit input errors)
        );
    }

    /**
     * Stop the transcoding process
     */
    stop() {
        if (this.process) {
            console.log(`[TranscodeSession ${this.id}] Stopping FFmpeg process`);
            this.process.kill('SIGTERM');
            // Force kill after 2 seconds if still running
            setTimeout(() => {
                if (this.process) {
                    this.process.kill('SIGKILL');
                }
            }, 2000);
        }

        if (this.sourceCacheProcess) {
            console.log(`[TranscodeSession ${this.id}] Stopping source cache download`);
            this.sourceCacheProcess.kill('SIGTERM');
            setTimeout(() => {
                if (this.sourceCacheProcess) {
                    this.sourceCacheProcess.kill('SIGKILL');
                }
            }, 2000);
        }

        fs.rm(this.sourceCachePath, { force: true })
            .then(() => {
                console.log(`[TranscodeSession ${this.id}] Removed source cache file`);
            })
            .catch(() => {});

        for (const proc of this.subtitleProcesses) {
            try {
                proc.kill('SIGTERM');
            } catch {}
        }

        setTimeout(() => {
            this.subtitleProcesses.forEach((proc) => {
                try {
                    proc.kill('SIGKILL');
                } catch {}
            });
            this.subtitleProcesses = [];
        }, 2000);

        this.status = 'stopped';
    }

    /**
     * Update last access time (prevents cleanup)
     */
    touch() {
        this.lastAccess = Date.now();
    }

    /**
     * Check if playlist exists and is ready
     */
    async isPlaylistReady() {
        try {
            await fs.access(this.playlistPath);
            const content = await fs.readFile(this.playlistPath, 'utf8');

            // Master playlist is ready if it references at least one child playlist,
            // or a regular playlist is ready if it references segments.
           return content.includes('.m3u8') || content.includes('.ts') || content.includes('.vtt') || (await fs.readdir(this.dir)).some(name => name.endsWith('.vtt'));
        } catch {
            return false;
        }
    }

    /**
     * Wait for playlist to be ready (with timeout)
     */
    async waitForPlaylist(timeoutMs = 10000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            if (await this.isPlaylistReady()) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return false;
    }

    /**
     * Get the HLS playlist content
     */
    async getPlaylist(playlistName = 'stream.m3u8') {
    this.touch();

    const targetPath = path.join(this.dir, playlistName);

    try {
            return await fs.readFile(targetPath, 'utf8');
        } catch (err) {
            return null;
        }
    }

    /**
     * Get a specific segment
     */
    async getSegment(segmentName) {
        this.touch();
        const segmentPath = path.join(this.dir, segmentName);
        try {
            await fs.access(segmentPath);
            return segmentPath;
        } catch {
            return null;
        }
    }

    /**
     * Save session metadata to disk for recovery
     */
    async persist() {
        const metadata = {
            id: this.id,
            url: this.url,
            status: this.status,
            startTime: this.startTime,
            lastAccess: this.lastAccess,
            options: this.options,
            seekOffset: this.options.seekOffset
        };
        const metaPath = path.join(this.dir, 'session.json');
        await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));
    }

    /**
     * Restore a session from disk metadata
     */
    static async restore(sessionDir) {
        const metaPath = path.join(sessionDir, 'session.json');
        try {
            const data = await fs.readFile(metaPath, 'utf8');
            const metadata = JSON.parse(data);
            const session = new TranscodeSession(metadata.url, metadata.options);
            session.id = metadata.id;
            session.dir = sessionDir;
            session.playlistPath = path.join(sessionDir, 'stream.m3u8');
            session.startTime = metadata.startTime;
            session.lastAccess = metadata.lastAccess;
            session.status = 'stopped'; // Not running after restart
            return session;
        } catch (err) {
            console.error(`Failed to restore session from ${sessionDir}:`, err.message);
            return null;
        }
    }

    /**
     * Delete session directory and all segments
     */
    async cleanup() {
        this.stop();
        try {
            await fs.rm(this.dir, { recursive: true, force: true });
            console.log(`[TranscodeSession ${this.id}] Cleaned up session directory`);
        } catch (err) {
            console.error(`[TranscodeSession ${this.id}] Failed to cleanup:`, err.message);
        }
    }
}

/**
 * Session Manager
 */

/**
 * Create a new transcode session
 */
async function createSession(url, options = {}) {
    await ensureCacheDir();
    const session = new TranscodeSession(url, options);
    sessions.set(session.id, session);
    return session;
}

/**
 * Get an existing session by ID
 */
function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        session.touch();
    }
    return session;
}

/**
 * Get or create a session for a URL (reuses existing if still valid)
 */
async function getOrCreateSession(url, options = {}) {
    // Check for existing session with same URL
    for (const session of sessions.values()) {
        if (session.url === url && session.status === 'running') {
            session.touch();
            return session;
        }
    }
    // Create new session
    return createSession(url, options);
}

/**
 * Stop and remove a session
 */
async function removeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        await session.cleanup();
        sessions.delete(sessionId);
    }
}

/**
 * Cleanup stale sessions (idle for too long)
 */
async function cleanupStaleSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        if (now - session.lastAccess > SESSION_TIMEOUT_MS) {
            console.log(`[TranscodeSession] Cleaning up stale session ${id}`);
            await removeSession(id);
        }
    }
}

/**
 * Recover sessions from disk after server restart
 */
async function recoverSessions() {
    try {
        await fs.access(CACHE_DIR);
        const dirs = await fs.readdir(CACHE_DIR, { withFileTypes: true });

        for (const dirent of dirs) {
            if (dirent.isDirectory()) {
                const sessionDir = path.join(CACHE_DIR, dirent.name);
                const session = await TranscodeSession.restore(sessionDir);
                if (session) {
                    sessions.set(session.id, session);
                    console.log(`[TranscodeSession] Recovered session ${session.id}`);
                }
            }
        }
    } catch (err) {
        // Cache dir doesn't exist yet, that's fine
        if (err.code !== 'ENOENT') {
            console.error('[TranscodeSession] Error recovering sessions:', err.message);
        }
    }
}

/**
 * Start cleanup interval
 */
let cleanupInterval = null;
function startCleanupInterval() {
    if (!cleanupInterval) {
        cleanupInterval = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
        cleanupInterval.unref(); // Don't prevent process exit
    }
}

/**
 * Get all active sessions (for debugging/monitoring)
 */
function getAllSessions() {
    return Array.from(sessions.values()).map(s => ({
        id: s.id,
        url: s.url,
        status: s.status,
        startTime: s.startTime,
        lastAccess: s.lastAccess,
        idleMs: Date.now() - s.lastAccess
    }));
}

module.exports = {
    TranscodeSession,
    createSession,
    getSession,
    getOrCreateSession,
    removeSession,
    cleanupStaleSessions,
    recoverSessions,
    startCleanupInterval,
    getAllSessions,
    CACHE_DIR,
    SEGMENT_DURATION
};
