/**
 * Root Operator Tunnel Assignment Worker
 *
 * Programmatically assigns Cloudflare Tunnels to desktop app installations.
 * Each machine gets a persistent, dedicated tunnel with a unique subdomain.
 *
 * Endpoints:
 *   POST /api/v1/tunnel/request   - Request/create tunnel for a machine
 *   POST /api/v1/tunnel/customize - Change subdomain for existing tunnel
 *
 * Security:
 *   - ECDSA P-256 signature verification (TOFU model)
 *   - Challenge-response with timestamp validation
 *   - Rate limiting per machine
 *   - Reserved subdomain protection
 */

// Reserved subdomains that cannot be claimed
const RESERVED_SUBDOMAINS = new Set([
  'www', 'api', 'admin', 'mail', 'smtp', 'pop', 'imap', 'ftp',
  'ssh', 'vpn', 'ns1', 'ns2', 'dns', 'mx', 'app', 'dashboard',
  'status', 'help', 'support', 'blog', 'docs', 'cdn', 'static',
  'assets', 'img', 'images', 'js', 'css', 'fonts', 'media',
  'root', 'operator', 'rootoperator', 'tunnel', 'bridge'
]);

// Rate limit: max requests per machine per hour
const RATE_LIMIT_TUNNEL_REQUESTS = 100; // Getting/creating tunnel (high for testing)
const RATE_LIMIT_CUSTOMIZE_REQUESTS = 100; // Changing subdomain (high for testing)
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Challenge timestamp validity window
const CHALLENGE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// Subdomain validation regex (alphanumeric + hyphens, 3-32 chars, no leading/trailing hyphen)
const SUBDOMAIN_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Generate a random subdomain (6 lowercase alphanumeric chars)
 */
function generateSubdomain() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let subdomain = '';
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  for (let i = 0; i < 6; i++) {
    subdomain += chars[array[i] % chars.length];
  }
  return subdomain;
}

/**
 * Validate subdomain format
 */
function isValidSubdomain(subdomain) {
  if (!subdomain || typeof subdomain !== 'string') return false;
  const lower = subdomain.toLowerCase();
  if (RESERVED_SUBDOMAINS.has(lower)) return false;
  return SUBDOMAIN_REGEX.test(lower);
}

/**
 * Import ECDSA public key from JWK
 */
async function importPublicKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify']
  );
}

/**
 * Verify ECDSA signature
 */
async function verifySignature(publicKey, signature, data) {
  const encoder = new TextEncoder();
  const signatureBuffer = base64ToArrayBuffer(signature);
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signatureBuffer,
    encoder.encode(data)
  );
}

/**
 * Convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Check rate limit for a machine
 */
async function checkRateLimit(env, machineId, type = 'tunnel') {
  const maxRequests = type === 'customize' ? RATE_LIMIT_CUSTOMIZE_REQUESTS : RATE_LIMIT_TUNNEL_REQUESTS;
  const key = `ratelimit:${type}:${machineId}`;
  const data = await env.MACHINES.get(key, { type: 'json' });

  if (!data) {
    // First request
    await env.MACHINES.put(key, JSON.stringify({
      count: 1,
      windowStart: Date.now()
    }), { expirationTtl: 3600 }); // 1 hour TTL
    return true;
  }

  const now = Date.now();
  if (now - data.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Window expired, reset
    await env.MACHINES.put(key, JSON.stringify({
      count: 1,
      windowStart: now
    }), { expirationTtl: 3600 });
    return true;
  }

  if (data.count >= maxRequests) {
    return false; // Rate limited
  }

  // Increment counter
  await env.MACHINES.put(key, JSON.stringify({
    count: data.count + 1,
    windowStart: data.windowStart
  }), { expirationTtl: 3600 });
  return true;
}

/**
 * Cloudflare API helper
 */
async function cfApi(env, method, endpoint, body = null) {
  const url = `https://api.cloudflare.com/client/v4${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  if (!data.success) {
    console.error('Cloudflare API error:', JSON.stringify(data.errors));
    throw new Error(data.errors?.[0]?.message || 'Cloudflare API error');
  }

  return data.result;
}

/**
 * Create a new Cloudflare Tunnel
 */
async function createTunnel(env, name) {
  return cfApi(env, 'POST', `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel`, {
    name,
    config_src: 'cloudflare'
  });
}

/**
 * Configure tunnel ingress rules
 */
async function configureTunnel(env, tunnelId, hostname) {
  return cfApi(env, 'PUT', `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    config: {
      ingress: [
        { hostname, service: 'http://localhost:22000' },
        { service: 'http_status:404' }
      ]
    }
  });
}

/**
 * Create DNS CNAME record for subdomain
 */
async function createDnsRecord(env, subdomain, tunnelId) {
  const hostname = `${subdomain}.${env.DOMAIN}`;
  return cfApi(env, 'POST', `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records`, {
    type: 'CNAME',
    name: hostname,
    content: `${tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1 // Auto
  });
}

/**
 * Delete DNS record by ID
 */
async function deleteDnsRecord(env, recordId) {
  return cfApi(env, 'DELETE', `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records/${recordId}`);
}

/**
 * Find DNS record by name
 */
async function findDnsRecord(env, hostname) {
  const records = await cfApi(env, 'GET', `/zones/${env.CLOUDFLARE_ZONE_ID}/dns_records?name=${hostname}&type=CNAME`);
  return records[0] || null;
}

/**
 * Get tunnel token
 */
async function getTunnelToken(env, tunnelId) {
  const result = await cfApi(env, 'GET', `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`);
  return result.token || result;
}

/**
 * Handle POST /api/v1/tunnel/request
 *
 * Request body:
 *   - machineId: string (UUID)
 *   - publicKeyJWK: object (ECDSA P-256 public key in JWK format)
 *   - signature: string (base64 encoded signature)
 *   - challenge: string (random nonce)
 *   - timestamp: number (Unix timestamp in ms)
 */
async function handleTunnelRequest(request, env) {
  const body = await request.json();
  const { machineId, publicKeyJWK, signature, challenge, timestamp } = body;

  // Validate required fields
  if (!machineId || !publicKeyJWK || !signature || !challenge || !timestamp) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  // Validate timestamp (prevent replay attacks)
  const now = Date.now();
  if (Math.abs(now - timestamp) > CHALLENGE_MAX_AGE_MS) {
    return jsonResponse({ error: 'Challenge expired' }, 400);
  }

  // Check rate limit (tunnel type)
  if (!await checkRateLimit(env, machineId, 'tunnel')) {
    return jsonResponse({ error: 'Rate limited. Try again later.' }, 429);
  }

  // Check for existing machine record
  const existingData = await env.MACHINES.get(`machines:${machineId}`, { type: 'json' });

  try {
    // Import public key
    const publicKey = await importPublicKey(publicKeyJWK);

    // Construct message to verify: machineId + challenge + timestamp
    const message = `${machineId}:${challenge}:${timestamp}`;

    // Verify signature
    const isValid = await verifySignature(publicKey, signature, message);
    if (!isValid) {
      return jsonResponse({ error: 'Invalid signature' }, 401);
    }

    // If existing machine, verify public key matches (TOFU)
    if (existingData) {
      const existingKeyJson = JSON.stringify(existingData.publicKeyJWK);
      const newKeyJson = JSON.stringify(publicKeyJWK);
      if (existingKeyJson !== newKeyJson) {
        return jsonResponse({ error: 'Public key mismatch' }, 403);
      }

      // Return existing tunnel info
      return jsonResponse({
        success: true,
        tunnelToken: existingData.tunnelToken,
        subdomain: existingData.subdomain,
        hostname: `${existingData.subdomain}.${env.DOMAIN}`
      });
    }

    // New machine - create tunnel
    let subdomain = generateSubdomain();

    // Ensure subdomain is not taken
    let attempts = 0;
    while (await env.SUBDOMAINS.get(`subdomains:${subdomain}`)) {
      subdomain = generateSubdomain();
      attempts++;
      if (attempts > 10) {
        return jsonResponse({ error: 'Could not generate unique subdomain' }, 500);
      }
    }

    const hostname = `${subdomain}.${env.DOMAIN}`;

    // Create Cloudflare Tunnel
    console.log(`Creating tunnel for machine ${machineId} with subdomain ${subdomain}`);
    const tunnel = await createTunnel(env, `ro-${subdomain}`);
    const tunnelId = tunnel.id;

    // Configure tunnel ingress
    await configureTunnel(env, tunnelId, hostname);

    // Create DNS record
    const dnsRecord = await createDnsRecord(env, subdomain, tunnelId);

    // Get tunnel token
    const tunnelToken = await getTunnelToken(env, tunnelId);

    // Store machine data
    const machineData = {
      tunnelId,
      tunnelToken,
      subdomain,
      dnsRecordId: dnsRecord.id,
      publicKeyJWK,
      createdAt: Date.now()
    };
    await env.MACHINES.put(`machines:${machineId}`, JSON.stringify(machineData));

    // Store subdomain mapping
    await env.SUBDOMAINS.put(`subdomains:${subdomain}`, JSON.stringify({
      machineId,
      tunnelId
    }));

    return jsonResponse({
      success: true,
      tunnelToken,
      subdomain,
      hostname
    });

  } catch (error) {
    console.error('Tunnel request error:', error);
    return jsonResponse({ error: error.message || 'Internal server error' }, 500);
  }
}

/**
 * Handle POST /api/v1/tunnel/customize
 *
 * Request body:
 *   - machineId: string (UUID)
 *   - newSubdomain: string (desired subdomain)
 *   - signature: string (base64 encoded signature)
 *   - challenge: string (random nonce)
 *   - timestamp: number (Unix timestamp in ms)
 */
async function handleTunnelCustomize(request, env) {
  const body = await request.json();
  const { machineId, newSubdomain, signature, challenge, timestamp } = body;

  // Validate required fields
  if (!machineId || !newSubdomain || !signature || !challenge || !timestamp) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  // Validate subdomain format
  const subdomain = newSubdomain.toLowerCase();
  if (!isValidSubdomain(subdomain)) {
    return jsonResponse({ error: 'Invalid subdomain format. Use 3-32 alphanumeric characters and hyphens.' }, 400);
  }

  // Validate timestamp
  const now = Date.now();
  if (Math.abs(now - timestamp) > CHALLENGE_MAX_AGE_MS) {
    return jsonResponse({ error: 'Challenge expired' }, 400);
  }

  // Check rate limit (customize type)
  if (!await checkRateLimit(env, machineId, 'customize')) {
    return jsonResponse({ error: 'Rate limited. Try again later.' }, 429);
  }

  // Get existing machine record
  const existingData = await env.MACHINES.get(`machines:${machineId}`, { type: 'json' });
  if (!existingData) {
    return jsonResponse({ error: 'Machine not found. Request tunnel first.' }, 404);
  }

  try {
    // Import and verify signature
    const publicKey = await importPublicKey(existingData.publicKeyJWK);
    const message = `${machineId}:${subdomain}:${challenge}:${timestamp}`;
    const isValid = await verifySignature(publicKey, signature, message);
    if (!isValid) {
      return jsonResponse({ error: 'Invalid signature' }, 401);
    }

    // Check if subdomain is same as current
    if (subdomain === existingData.subdomain) {
      return jsonResponse({
        success: true,
        subdomain,
        hostname: `${subdomain}.${env.DOMAIN}`,
        message: 'Subdomain unchanged'
      });
    }

    // Check if new subdomain is available
    const existingSubdomain = await env.SUBDOMAINS.get(`subdomains:${subdomain}`);
    if (existingSubdomain) {
      return jsonResponse({ error: 'Subdomain already taken' }, 409);
    }

    const oldHostname = `${existingData.subdomain}.${env.DOMAIN}`;
    const newHostname = `${subdomain}.${env.DOMAIN}`;

    // Delete old DNS record
    if (existingData.dnsRecordId) {
      try {
        await deleteDnsRecord(env, existingData.dnsRecordId);
      } catch (e) {
        console.log('Could not delete old DNS record:', e.message);
      }
    }

    // Create new DNS record
    const newDnsRecord = await createDnsRecord(env, subdomain, existingData.tunnelId);

    // Update tunnel ingress config
    await configureTunnel(env, existingData.tunnelId, newHostname);

    // Update KV records
    const oldSubdomain = existingData.subdomain;

    // Delete old subdomain mapping
    await env.SUBDOMAINS.delete(`subdomains:${oldSubdomain}`);

    // Create new subdomain mapping
    await env.SUBDOMAINS.put(`subdomains:${subdomain}`, JSON.stringify({
      machineId,
      tunnelId: existingData.tunnelId
    }));

    // Update machine record
    const updatedData = {
      ...existingData,
      subdomain,
      dnsRecordId: newDnsRecord.id,
      updatedAt: Date.now()
    };
    await env.MACHINES.put(`machines:${machineId}`, JSON.stringify(updatedData));

    return jsonResponse({
      success: true,
      subdomain,
      hostname: newHostname,
      oldSubdomain: oldSubdomain
    });

  } catch (error) {
    console.error('Customize error:', error);
    return jsonResponse({ error: error.message || 'Internal server error' }, 500);
  }
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

/**
 * Main fetch handler
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }

    // Route requests
    if (request.method === 'POST') {
      if (url.pathname === '/api/v1/tunnel/request') {
        return handleTunnelRequest(request, env);
      }
      if (url.pathname === '/api/v1/tunnel/customize') {
        return handleTunnelCustomize(request, env);
      }
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return jsonResponse({ status: 'ok', service: 'root-operator-tunnel-worker' });
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};
