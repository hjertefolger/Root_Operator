const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_OUTBOUND_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const OUTBOUND_ATTACHMENT_GC_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const OUTBOUND_ATTACHMENT_KIND = 'image';
const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
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

function readValidatedImageFile(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
        throw new Error(`Attachment is not a file: ${filePath}`);
    }
    if (stat.size <= 0) {
        throw new Error(`Attachment is empty: ${filePath}`);
    }
    if (stat.size > MAX_OUTBOUND_ATTACHMENT_SIZE) {
        throw new Error(`Attachment exceeds 10 MB: ${filePath}`);
    }

    const buffer = fs.readFileSync(filePath);
    const mime = detectImageMime(buffer);
    if (!mime || !ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
        throw new Error(`Unsupported attachment type: ${filePath}`);
    }

    return {
        buffer,
        mime,
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
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
                const sourceFile = readValidatedImageFile(sourcePath);
                fs.writeFileSync(stagedPath, sourceFile.buffer, { flag: 'wx' });
            }

            const stagedFile = readValidatedImageFile(stagedPath);
            staged.push({
                id: computeAttachmentId(effectId, index),
                kind: OUTBOUND_ATTACHMENT_KIND,
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

    const stagedFile = readValidatedImageFile(stagedPath);
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
    MAX_OUTBOUND_ATTACHMENT_SIZE,
    OUTBOUND_ATTACHMENT_GC_GRACE_MS,
    OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS,
    OUTBOUND_ATTACHMENT_KIND,
    buildStagedAttachmentFilename,
    computeAttachmentId,
    detectImageMime,
    getStagedAttachmentPath,
    loadStagedAttachmentBytes,
    sanitizeAttachmentName,
    sanitizeEffectToken,
    stageOutboundAttachments,
    stripAttachmentBytes,
    touchAttachmentForGc,
};
