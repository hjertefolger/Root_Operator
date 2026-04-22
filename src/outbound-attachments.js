const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_OUTBOUND_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_OUTBOUND_VIDEO_SIZE = 100 * 1024 * 1024;
// Back-compat export: callers that pinned to "the max" used this name when
// images were the only kind. Keep it as the image limit.
const MAX_OUTBOUND_ATTACHMENT_SIZE = MAX_OUTBOUND_IMAGE_SIZE;

const OUTBOUND_ATTACHMENT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const OUTBOUND_ATTACHMENT_KIND = 'image';
const OUTBOUND_ATTACHMENT_KIND_IMAGE = 'image';
const OUTBOUND_ATTACHMENT_KIND_VIDEO = 'video';

const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
]);

const ALLOWED_VIDEO_MIME_TYPES = new Set([
    'video/mp4',
    'video/quicktime',
    'video/webm',
]);

function sanitizeAttachmentName(name) {
    const base = path.basename(String(name || '').trim());
    const sanitized = base.replace(/[^a-zA-Z0-9._\- ]/g, '_');
    if (!sanitized || sanitized === '.' || sanitized === '..') {
        return 'attachment';
    }
    return sanitized;
}

function sanitizeEffectToken(effectId) {
    const raw = String(effectId || 'reply').trim();
    const sanitized = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
    return sanitized || 'reply';
}

function computeAttachmentId(effectId, index) {
    return `${effectId || 'reply'}-${index}`;
}

function detectImageMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return null;
    }

    if (
        buffer[0] === 0x89
        && buffer[1] === 0x50
        && buffer[2] === 0x4E
        && buffer[3] === 0x47
        && buffer[4] === 0x0D
        && buffer[5] === 0x0A
        && buffer[6] === 0x1A
        && buffer[7] === 0x0A
    ) {
        return 'image/png';
    }

    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
        return 'image/jpeg';
    }

    const gifHeader = buffer.subarray(0, 6).toString('ascii');
    if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
        return 'image/gif';
    }

    const riffHeader = buffer.subarray(0, 4).toString('ascii');
    const webpHeader = buffer.subarray(8, 12).toString('ascii');
    if (riffHeader === 'RIFF' && webpHeader === 'WEBP') {
        return 'image/webp';
    }

    return null;
}

function detectVideoMime(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
        return null;
    }

    // WebM / Matroska EBML header: 0x1A 0x45 0xDF 0xA3
    if (
        buffer[0] === 0x1A
        && buffer[1] === 0x45
        && buffer[2] === 0xDF
        && buffer[3] === 0xA3
    ) {
        return 'video/webm';
    }

    // ISO base media family (MP4, MOV). Bytes 4-7 are the box type "ftyp"
    // for the very first box of any ISO-BMFF file. Bytes 8-11 are the major
    // brand, which distinguishes MP4 variants ("mp41", "mp42", "isom",
    // "iso2"-"iso5", "avc1", "dash", …) from QuickTime ("qt  ").
    const boxType = buffer.subarray(4, 8).toString('ascii');
    if (boxType === 'ftyp') {
        const brand = buffer.subarray(8, 12).toString('ascii');
        if (brand === 'qt  ') {
            return 'video/quicktime';
        }
        return 'video/mp4';
    }

    return null;
}

function detectAttachmentMime(buffer) {
    const image = detectImageMime(buffer);
    if (image) {
        return { mime: image, kind: OUTBOUND_ATTACHMENT_KIND_IMAGE };
    }
    const video = detectVideoMime(buffer);
    if (video) {
        return { mime: video, kind: OUTBOUND_ATTACHMENT_KIND_VIDEO };
    }
    return null;
}

function limitForKind(kind) {
    if (kind === OUTBOUND_ATTACHMENT_KIND_VIDEO) {
        return MAX_OUTBOUND_VIDEO_SIZE;
    }
    return MAX_OUTBOUND_IMAGE_SIZE;
}

function describeSizeLimit(kind) {
    const bytes = limitForKind(kind);
    const megabytes = Math.round(bytes / (1024 * 1024));
    return `${megabytes} MB`;
}

function readValidatedAttachmentFile(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Attachment is not a file: ${filePath}`);
    }
    if (stat.size <= 0) {
        throw new Error(`Attachment is empty: ${filePath}`);
    }

    // Read the first 64KB to sniff the mime type without pulling a multi-MB
    // video into memory twice. Then re-read the full payload once we know
    // the kind (so the limit check is accurate).
    const headBuffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    const fd = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fd, headBuffer, 0, headBuffer.length, 0);
    } finally {
        fs.closeSync(fd);
    }

    const detected = detectAttachmentMime(headBuffer);
    if (!detected) {
        throw new Error(`Unsupported attachment type: ${filePath}`);
    }

    const limit = limitForKind(detected.kind);
    if (stat.size > limit) {
        throw new Error(
            `Attachment exceeds ${describeSizeLimit(detected.kind)}: ${filePath}`,
        );
    }

    const buffer = fs.readFileSync(filePath);
    // Re-verify the mime against the full buffer — defends against truncated
    // reads and mismatched head/body content.
    const confirmed = detectAttachmentMime(buffer);
    if (!confirmed || confirmed.kind !== detected.kind || confirmed.mime !== detected.mime) {
        throw new Error(`Unsupported attachment type: ${filePath}`);
    }

    const allowedMimes = detected.kind === OUTBOUND_ATTACHMENT_KIND_VIDEO
        ? ALLOWED_VIDEO_MIME_TYPES
        : ALLOWED_IMAGE_MIME_TYPES;
    if (!allowedMimes.has(confirmed.mime)) {
        throw new Error(`Unsupported attachment type: ${filePath}`);
    }

    return {
        buffer,
        mime: confirmed.mime,
        kind: confirmed.kind,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
}

// Retained for back-compat with any caller that wanted the image-only check
// explicitly. New code should use readValidatedAttachmentFile.
function readValidatedImageFile(filePath) {
    const result = readValidatedAttachmentFile(filePath);
    if (result.kind !== OUTBOUND_ATTACHMENT_KIND_IMAGE) {
        throw new Error(`Attachment is not an image: ${filePath}`);
    }
    return {
        buffer: result.buffer,
        mime: result.mime,
        size: result.size,
        sha256: result.sha256,
    };
}

function buildStagedAttachmentFilename(effectId, index, name) {
    return `${sanitizeEffectToken(effectId)}-${index}-${sanitizeAttachmentName(name)}`;
}

function getStagedAttachmentPath(outboundDir, effectId, index, name) {
    const filename = buildStagedAttachmentFilename(effectId, index, name);
    return path.join(outboundDir, filename);
}

function stageOutboundAttachments({ outboundDir, effectId, attachments }) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return [];
    }

    fs.mkdirSync(outboundDir, { recursive: true });
    const staged = [];
    try {
        for (let index = 0; index < attachments.length; index += 1) {
            const sourcePath = attachments[index];
            if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
                throw new Error(`Attachment ${index + 1} is missing a file path`);
            }
            if (!path.isAbsolute(sourcePath)) {
                throw new Error(`Attachment path must be absolute: ${sourcePath}`);
            }

            const sourceName = sanitizeAttachmentName(sourcePath);
            const stagedPath = getStagedAttachmentPath(outboundDir, effectId, index, sourceName);
            const stagedExists = fs.existsSync(stagedPath);

            if (!stagedExists) {
                if (!fs.existsSync(sourcePath)) {
                    throw new Error(`Attachment file not found: ${sourcePath}`);
                }
                const sourceFile = readValidatedAttachmentFile(sourcePath);
                fs.writeFileSync(stagedPath, sourceFile.buffer, { flag: 'wx' });
            }

            const stagedFile = readValidatedAttachmentFile(stagedPath);
            staged.push({
                id: computeAttachmentId(effectId, index),
                kind: stagedFile.kind,
                name: sourceName,
                mime: stagedFile.mime,
                size: stagedFile.size,
                sha256: stagedFile.sha256,
                stagedPath,
                created: !stagedExists,
            });
        }
    } catch (error) {
        for (const attachment of staged) {
            if (attachment.created && attachment.stagedPath && fs.existsSync(attachment.stagedPath)) {
                try {
                    fs.unlinkSync(attachment.stagedPath);
                } catch {
                    // Ignore cleanup errors — caller surfaces the original failure.
                }
            }
        }
        throw error;
    }

    return staged;
}

function stripAttachmentBytes(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return undefined;
    }

    return attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        sha256: attachment.sha256,
        kind: attachment.kind || OUTBOUND_ATTACHMENT_KIND,
    }));
}

function loadStagedAttachmentBytes({ outboundDir, effectId, attachment, attachmentIndex }) {
    if (!attachment || typeof attachment !== 'object') {
        throw new Error('Attachment metadata missing');
    }

    if (!effectId || typeof effectId !== 'string') {
        throw new Error('Attachment effect id missing');
    }

    if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
        throw new Error('Attachment index missing');
    }

    const stagedPath = getStagedAttachmentPath(outboundDir, effectId, attachmentIndex, attachment.name);
    if (!fs.existsSync(stagedPath)) {
        throw new Error('Attachment bytes unavailable');
    }

    const stagedFile = readValidatedAttachmentFile(stagedPath);
    return {
        bytesBase64: stagedFile.buffer.toString('base64'),
        mime: stagedFile.mime,
    };
}

function touchAttachmentForGc(filePath, now = new Date()) {
    if (!filePath || !fs.existsSync(filePath)) {
        return;
    }
    fs.utimesSync(filePath, now, now);
}

module.exports = {
    ALLOWED_IMAGE_MIME_TYPES,
    ALLOWED_VIDEO_MIME_TYPES,
    MAX_OUTBOUND_ATTACHMENT_SIZE,
    MAX_OUTBOUND_IMAGE_SIZE,
    MAX_OUTBOUND_VIDEO_SIZE,
    OUTBOUND_ATTACHMENT_GC_GRACE_MS,
    OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS,
    OUTBOUND_ATTACHMENT_KIND,
    OUTBOUND_ATTACHMENT_KIND_IMAGE,
    OUTBOUND_ATTACHMENT_KIND_VIDEO,
    buildStagedAttachmentFilename,
    computeAttachmentId,
    detectAttachmentMime,
    detectImageMime,
    detectVideoMime,
    getStagedAttachmentPath,
    loadStagedAttachmentBytes,
    readValidatedAttachmentFile,
    readValidatedImageFile,
    sanitizeAttachmentName,
    sanitizeEffectToken,
    stageOutboundAttachments,
    stripAttachmentBytes,
    touchAttachmentForGc,
};
