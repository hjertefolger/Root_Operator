const DEFAULT_ACTIVITY_ASSISTANT_NAME = 'Operator'
const PUSH_SUBSCRIPTIONS_STORE_KEY = 'pushSubscriptions'
const PUSH_VAPID_KEYS_STORE_KEY = 'pushVapidKeys'
const PUSH_NOTIFICATION_TARGET_URL = '/'
const PUSH_NOTIFICATION_SUBJECT = 'https://github.com/hjertefolger/Root_Operator'
const PUSH_NOTIFICATION_TAG = 'root-operator-assistant-reply'
const PUSH_NOTIFICATION_ICON = '/icon-192-v3.png'
const PUSH_STALE_HEARTBEAT_THRESHOLD_MS = 35000

function init(deps = {}) {
    const {
        app,
        BrowserWindow,
        Notification,
        WebSocket,
        safeStorage,
        webpush,
        logDebug = () => {},
        getStore = () => null,
        getMainWindow = () => null,
        getLocalChatWindow = () => null,
        createLocalChatWindow = () => {},
        getActiveClients = () => [],
        desktopNotificationIconPath = '',
        defaultActivityAssistantName = DEFAULT_ACTIVITY_ASSISTANT_NAME,
        pushSubscriptionsStoreKey = PUSH_SUBSCRIPTIONS_STORE_KEY,
        pushVapidKeysStoreKey = PUSH_VAPID_KEYS_STORE_KEY,
        pushNotificationTargetUrl = PUSH_NOTIFICATION_TARGET_URL,
        pushNotificationSubject = PUSH_NOTIFICATION_SUBJECT,
    } = deps

    assertFunction(getStore, 'getStore')
    assertFunction(getMainWindow, 'getMainWindow')
    assertFunction(getLocalChatWindow, 'getLocalChatWindow')
    assertFunction(createLocalChatWindow, 'createLocalChatWindow')
    assertFunction(getActiveClients, 'getActiveClients')
    assertDependency(app, 'app')
    assertDependency(BrowserWindow, 'BrowserWindow')
    assertDependency(Notification, 'Notification')
    assertDependency(WebSocket, 'WebSocket')
    assertDependency(safeStorage, 'safeStorage')
    assertDependency(webpush, 'webpush')

    let cachedPushVapidKeys

    function resolveStore() {
        return getStore() || null
    }

    function debug(message) {
        logDebug(message)
    }

    function getActivityAssistantName() {
        const rawName = resolveStore()?.get('cfSettings', {})?.assistantName
        if (typeof rawName !== 'string') {
            return defaultActivityAssistantName
        }

        const trimmedName = rawName.trim()
        return trimmedName || defaultActivityAssistantName
    }

    function buildNotificationPreviewBody(content = '') {
        if (typeof content !== 'string') {
            return `${getActivityAssistantName()} sent a new message`
        }

        const cleaned = content
            .replace(/\s+/g, ' ')
            .replace(/[`*_>#-]+/g, ' ')
            .trim()

        if (!cleaned) {
            return `${getActivityAssistantName()} sent a new message`
        }

        const maxLength = 140
        return cleaned.length > maxLength
            ? `${cleaned.slice(0, maxLength - 1).trimEnd()}...`
            : cleaned
    }

    function getPushAssistantNotificationPayload(message = {}) {
        const assistantName = getActivityAssistantName()
        const title = assistantName || 'New message'
        const body = buildNotificationPreviewBody(message.content)
        return {
            title,
            body,
            tag: PUSH_NOTIFICATION_TAG,
            url: pushNotificationTargetUrl,
            assistantName,
            ts: message.ts || new Date().toISOString(),
            icon: PUSH_NOTIFICATION_ICON,
            badge: PUSH_NOTIFICATION_ICON,
            web_push: 8030,
            navigate: pushNotificationTargetUrl,
            notification: {
                title,
                body,
                icon: PUSH_NOTIFICATION_ICON,
                badge: PUSH_NOTIFICATION_ICON,
                tag: PUSH_NOTIFICATION_TAG,
            },
        }
    }

    function getDesktopAssistantNotificationPayload(message = {}) {
        return {
            title: 'Root Operator',
            subtitle: getActivityAssistantName(),
            body: buildNotificationPreviewBody(message.content),
        }
    }

    function getStoredPushSubscriptions() {
        const store = resolveStore()
        if (!store) {
            return []
        }

        const subscriptions = store.get(pushSubscriptionsStoreKey, [])
        return Array.isArray(subscriptions) ? subscriptions : []
    }

    function savePushSubscriptions(subscriptions) {
        const store = resolveStore()
        if (!store) {
            return
        }

        store.set(pushSubscriptionsStoreKey, Array.isArray(subscriptions) ? subscriptions : [])
    }

    function isEncryptedPushVapidKeysRecord(value) {
        return (
            value
            && typeof value.publicKey === 'string'
            && value.publicKey
            && typeof value.privateKeyEncrypted === 'string'
            && value.privateKeyEncrypted
            && typeof value.privateKey !== 'string'
        )
    }

    function isPlaintextPushVapidKeysRecord(value) {
        return (
            value
            && typeof value.publicKey === 'string'
            && value.publicKey
            && typeof value.privateKey === 'string'
            && value.privateKey
        )
    }

    function storeEncryptedPushVapidKeys(vapidKeys) {
        const store = resolveStore()
        if (!store) {
            throw new Error('Push VAPID keys require a configured store')
        }

        const storedVapidKeys = {
            publicKey: vapidKeys.publicKey,
            privateKeyEncrypted: safeStorage.encryptString(vapidKeys.privateKey).toString('base64'),
        }

        store.set(pushVapidKeysStoreKey, storedVapidKeys)

        const verified = store.get(pushVapidKeysStoreKey, null)
        if (
            !isEncryptedPushVapidKeysRecord(verified)
            || verified.publicKey !== storedVapidKeys.publicKey
            || verified.privateKeyEncrypted !== storedVapidKeys.privateKeyEncrypted
        ) {
            throw new Error('Failed to verify stored VAPID key record')
        }

        return storedVapidKeys
    }

    function decryptStoredPushVapidKeys(storedVapidKeys) {
        return {
            publicKey: storedVapidKeys.publicKey,
            privateKey: safeStorage.decryptString(Buffer.from(storedVapidKeys.privateKeyEncrypted, 'base64')),
        }
    }

    function getStoredPushVapidKeys() {
        const store = resolveStore()

        if (cachedPushVapidKeys !== undefined) {
            return cachedPushVapidKeys
        }

        if (!store) {
            return null
        }

        if (!safeStorage.isEncryptionAvailable()) {
            debug('[SECURITY] safeStorage unavailable, push notifications disabled')
            cachedPushVapidKeys = null
            return null
        }

        try {
            const existing = store.get(pushVapidKeysStoreKey, null)
            if (isEncryptedPushVapidKeysRecord(existing)) {
                try {
                    cachedPushVapidKeys = decryptStoredPushVapidKeys(existing)
                    return cachedPushVapidKeys
                } catch (error) {
                    debug('[SECURITY] Failed to decrypt VAPID private key - regenerating')
                    const regenerated = webpush.generateVAPIDKeys()
                    storeEncryptedPushVapidKeys(regenerated)
                    savePushSubscriptions([])
                    debug('[NOTIFICATIONS] Generated VAPID keys - cleared stale subscriptions')
                    cachedPushVapidKeys = regenerated
                    return cachedPushVapidKeys
                }
            }

            if (isPlaintextPushVapidKeysRecord(existing)) {
                const migrated = {
                    publicKey: existing.publicKey,
                    privateKey: existing.privateKey,
                }
                storeEncryptedPushVapidKeys(migrated)
                debug('[SECURITY] Migrated VAPID private key to safeStorage')
                cachedPushVapidKeys = migrated
                return cachedPushVapidKeys
            }

            const generated = webpush.generateVAPIDKeys()
            storeEncryptedPushVapidKeys(generated)
            debug('[NOTIFICATIONS] Generated VAPID keys')
            cachedPushVapidKeys = generated
            return cachedPushVapidKeys
        } catch (error) {
            debug(`[NOTIFICATIONS] Failed to initialize VAPID keys: ${error.message}`)
            cachedPushVapidKeys = null
            return null
        }
    }

    function configureWebPush() {
        const vapidKeys = getStoredPushVapidKeys()
        if (!vapidKeys) {
            return null
        }

        webpush.setVapidDetails(
            pushNotificationSubject,
            vapidKeys.publicKey,
            vapidKeys.privateKey,
        )

        return vapidKeys
    }

    function normalizePushSubscription(subscription) {
        if (!subscription || typeof subscription !== 'object') {
            return null
        }

        const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : ''
        const keys = subscription.keys && typeof subscription.keys === 'object' ? subscription.keys : {}
        const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : ''
        const auth = typeof keys.auth === 'string' ? keys.auth.trim() : ''

        if (!endpoint || !p256dh || !auth) {
            return null
        }

        return {
            endpoint,
            expirationTime: typeof subscription.expirationTime === 'number' ? subscription.expirationTime : null,
            keys: { p256dh, auth },
        }
    }

    function getPairedDeviceLabel(kid) {
        if (!kid) {
            return 'Unknown device'
        }

        const keys = resolveStore()?.get('keys', []) || []
        const device = Array.isArray(keys) ? keys.find((item) => item.kid === kid) : null
        return device?.name || kid.substring(0, 12)
    }

    function buildNotificationStatePayload(kid) {
        const vapidKeys = configureWebPush()
        const subscriptions = getStoredPushSubscriptions()

        return {
            type: 'notifications_state',
            supported: Boolean(vapidKeys?.publicKey),
            vapidPublicKey: vapidKeys?.publicKey || '',
            subscribed: Boolean(kid && subscriptions.some((entry) => entry.kid === kid)),
        }
    }

    function sendNotificationState(ws) {
        const openState = typeof WebSocket.OPEN === 'number' ? WebSocket.OPEN : 1
        if (!ws || ws.readyState !== openState || !ws.authenticated) {
            return
        }

        try {
            ws.send(JSON.stringify(buildNotificationStatePayload(ws.kid || '')))
        } catch (error) {
            debug(`[NOTIFICATIONS] Failed to send notification state: ${error.message}`)
        }
    }

    function upsertPushSubscription({ kid, subscription, platform = '', userAgent = '' }) {
        const normalized = normalizePushSubscription(subscription)
        if (!kid || !normalized) {
            return false
        }

        const now = new Date().toISOString()
        const subscriptions = getStoredPushSubscriptions()
        const existing = subscriptions.find((entry) => entry.kid === kid)
        const next = subscriptions.filter(
            (entry) => entry.kid !== kid && entry.subscription?.endpoint !== normalized.endpoint,
        )

        next.push({
            kid,
            name: getPairedDeviceLabel(kid),
            subscription: normalized,
            platform: typeof platform === 'string' ? platform.trim() : '',
            userAgent: typeof userAgent === 'string' ? userAgent.trim() : '',
            createdAt: existing?.createdAt || now,
            updatedAt: now,
        })

        savePushSubscriptions(next)
        debug(`[NOTIFICATIONS] Registered push subscription for ${kid.substring(0, 8)}...`)
        return true
    }

    function removePushSubscriptionsForKid(kid) {
        if (!kid) {
            return
        }

        const subscriptions = getStoredPushSubscriptions()
        const next = subscriptions.filter((entry) => entry.kid !== kid)
        if (next.length !== subscriptions.length) {
            savePushSubscriptions(next)
            debug(`[NOTIFICATIONS] Removed push subscriptions for ${kid.substring(0, 8)}...`)
        }
    }

    function removePushSubscriptionByEndpoint(endpoint) {
        if (!endpoint) {
            return
        }

        const subscriptions = getStoredPushSubscriptions()
        const next = subscriptions.filter((entry) => entry.subscription?.endpoint !== endpoint)
        if (next.length !== subscriptions.length) {
            savePushSubscriptions(next)
            debug('[NOTIFICATIONS] Removed stale push subscription')
        }
    }

    function shouldSuppressDesktopNotification() {
        const focusedWindow = BrowserWindow.getFocusedWindow()
        return Boolean(
            focusedWindow
            && !focusedWindow.isDestroyed()
            && (focusedWindow === getLocalChatWindow() || focusedWindow === getMainWindow())
        )
    }

    function showDesktopAssistantNotification(message) {
        if (!Notification.isSupported() || shouldSuppressDesktopNotification()) {
            return
        }

        const payload = getDesktopAssistantNotificationPayload(message)
        const notification = new Notification({
            title: payload.title,
            subtitle: payload.subtitle,
            body: payload.body,
            icon: desktopNotificationIconPath,
            silent: false,
        })

        notification.on('click', () => {
            app.focus({ steal: true })
            createLocalChatWindow()
        })

        notification.show()
    }

    async function sendPushNotification(entry, payload) {
        try {
            await webpush.sendNotification(entry.subscription, JSON.stringify(payload), {
                TTL: 86400,
                urgency: 'high',
            })
        } catch (error) {
            if (error.statusCode === 404 || error.statusCode === 410) {
                removePushSubscriptionByEndpoint(entry.subscription?.endpoint)
            }
            throw error
        }
    }

    async function notifyPushSubscribers(message) {
        const subscriptions = getStoredPushSubscriptions()
        if (subscriptions.length === 0) {
            return
        }

        const now = Date.now()
        const activeClients = Array.from(getActiveClients() || [])
        const activeKids = new Set(
            activeClients
                .filter((client) => (
                    client.readyState === 1
                    && client.authenticated
                    && client.clientVisible === true
                    && (now - (client.lastHeartbeat || 0)) < PUSH_STALE_HEARTBEAT_THRESHOLD_MS
                ))
                .map((client) => client.kid)
                .filter(Boolean),
        )

        for (const client of activeClients) {
            const hbAge = client.lastHeartbeat ? now - client.lastHeartbeat : 'never'
            const kid8 = (client.kid || '?').substring(0, 8)
            const isOpen = client.readyState === 1
            const isAuth = !!client.authenticated
            const isVis = client.clientVisible === true
            const hbFresh = (now - (client.lastHeartbeat || 0)) < PUSH_STALE_HEARTBEAT_THRESHOLD_MS
            const suppressed = isOpen && isAuth && isVis && hbFresh
            const reason = suppressed
                ? 'SUPPRESSED (active)'
                : `PUSH (open=${isOpen} auth=${isAuth} vis=${isVis} hbFresh=${hbFresh})`
            debug(`[NOTIFICATIONS] Client ${kid8}: ${reason} hbAge=${hbAge}ms`)
        }

        const targets = subscriptions.filter((entry) => !activeKids.has(entry.kid))
        debug(`[NOTIFICATIONS] Push routing: ${subscriptions.length} subs, ${activeKids.size} active, ${targets.length} targets`)
        if (targets.length === 0) {
            debug('[NOTIFICATIONS] All devices have active WS - push suppressed')
            return
        }

        for (const target of targets) {
            debug(`[NOTIFICATIONS] Sending push to ${(target.kid || '?').substring(0, 8)} (${target.platform || 'unknown'})`)
        }

        const payload = getPushAssistantNotificationPayload(message)
        const results = await Promise.allSettled(targets.map((entry) => sendPushNotification(entry, payload)))
        const failures = results.filter((result) => result.status === 'rejected')
        if (failures.length > 0) {
            for (const failure of failures) {
                debug(`[NOTIFICATIONS] Push delivery failure: ${failure.reason?.message || failure.reason}`)
            }
        }
    }

    function notifyAssistantReply(message) {
        showDesktopAssistantNotification(message)
        notifyPushSubscribers(message).catch((error) => {
            debug(`[NOTIFICATIONS] Failed to deliver push notifications: ${error.message}`)
        })
    }

    function resetCachedPushVapidKeys() {
        cachedPushVapidKeys = null
    }

    return {
        getActivityAssistantName,
        buildNotificationPreviewBody,
        getPushAssistantNotificationPayload,
        getDesktopAssistantNotificationPayload,
        getStoredPushSubscriptions,
        savePushSubscriptions,
        getStoredPushVapidKeys,
        configureWebPush,
        normalizePushSubscription,
        buildNotificationStatePayload,
        sendNotificationState,
        upsertPushSubscription,
        removePushSubscriptionsForKid,
        removePushSubscriptionByEndpoint,
        showDesktopAssistantNotification,
        notifyPushSubscribers,
        notifyAssistantReply,
        resetCachedPushVapidKeys,
    }
}

function assertDependency(value, name) {
    if (!value) {
        throw new Error(`notifications.init missing dependency: ${name}`)
    }
}

function assertFunction(value, name) {
    if (typeof value !== 'function') {
        throw new Error(`notifications.init missing function dependency: ${name}`)
    }
}

module.exports = {
    init,
    constants: {
        DEFAULT_ACTIVITY_ASSISTANT_NAME,
        PUSH_SUBSCRIPTIONS_STORE_KEY,
        PUSH_VAPID_KEYS_STORE_KEY,
        PUSH_NOTIFICATION_TARGET_URL,
        PUSH_NOTIFICATION_SUBJECT,
        PUSH_NOTIFICATION_TAG,
        PUSH_NOTIFICATION_ICON,
        PUSH_STALE_HEARTBEAT_THRESHOLD_MS,
    },
}
