#!/usr/bin/env node

const express = require('express');
const YTDlpWrap = require('yt-dlp-wrap').default;
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');
// const util = require('util');

const tmpdir = require('os').tmpdir();
const ytDlpWrap = new YTDlpWrap();
const PORT = process.env.PORT || 7000;
const prefix = 'yt_id:';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'base64') : crypto.randomBytes(32);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedData) {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
        throw new Error('Invalid encrypted data format');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function generateYouTubeCookies(refreshToken) {
    const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();

    const browser = await puppeteer.launch({ 
        headless: true, 
        args: ['--no-sandbox'] 
    });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        Authorization: `Bearer ${credentials.access_token}`
    });
    await page.goto('https://accounts.google.com/', { waitUntil: 'networkidle0' });
    await page.waitForTimeout(2000);
    try {
        await page.goto('https://www.youtube.com/playlist?list=WL');
    } catch (error) {}
    await page.goto('https://www.youtube.com/robots.txt', { waitUntil: 'networkidle0' });
    const cookies = await page.cookies();
    const relevantCookies = cookies.filter(cookie => 
        cookie.domain.includes('youtube') || cookie.domain.includes('google')
    );
    await browser.close();
    
    const netscapeFormat = '# Netscape HTTP Cookie File\n' + 
        relevantCookies.map(cookie => [
            cookie.domain.startsWith('.') ? cookie.domain : '.' + cookie.domain,
            'TRUE',
            cookie.path || '/',
            cookie.secure ? 'TRUE' : 'FALSE',
            cookie.expires ? Math.floor(cookie.expires) : '0',
            cookie.name,
            cookie.value
        ].join('\t')).join('\n');
    return netscapeFormat;
}

let counter = 0;
async function runYtDlpWithConfig(auth, argsArray) {
    const cookies = generateYouTubeCookies(decryptConfig(auth)?.encrypted?.auth);
    const filename = cookies ? path.join(tmpdir, `cookies-${Date.now()}-${counter++}.txt`) : '';
    counter %= Number.MAX_SAFE_INTEGER;
    const fullArgs = [
        ...argsArray,
        '--skip-download',
        '--ignore-errors',
        '--no-warnings',
        '--no-cache-dir',
        ...(cookies ? ['--cookies', filename] : [])];
    try {
        if (filename) await fs.writeFile(filename, auth);
        return JSON.parse(await ytDlpWrap.execPromise(fullArgs));
    } catch (error) {
        console.log('Error running YT-DLP: ' + error);
        return {};
    } finally {
        try {
            if (filename) await fs.unlink(filename);
        } catch (error) {}
    }
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// OAuth Authorization Endpoint
app.get('/auth', (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return res.status(500).send('Google OAuth credentials not configured.');
    }
    const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
    const oauth2Client = new google.auth.OAuth2(
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        `${protocol}://${req.get('host')}/callback`
    );
    const state = req.query.state || '';
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/youtube.readonly'],
        state: state
    });
    res.redirect(authUrl);
});

// OAuth Callback Endpoint
app.get('/callback', async (req, res) => {
    if (!req.query.code) {
        return res.status(400).send('Authorization code missing.');
    }
    const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
    try {
        const oauth2Client = new google.auth.OAuth2(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            `${protocol}://${req.get('host')}/callback`
        );
        const { tokens } = await oauth2Client.getToken(req.query.code);
        if (!tokens.refresh_token) {
            return res.status(400).send('Refresh token not received.');
        }
        let configObj = { encrypted: encrypt(JSON.stringify({ auth: tokens.refresh_token })) };
        if (req.query.state) {
            configObj = { ...decryptConfig(req.query.state, false), encrypted: encrypted };
        }
        const configString = Buffer.from(JSON.stringify(configObj)).toString('base64');
        res.redirect(`/${configString}/configure`);
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send('Failed to process OAuth callback.');
    }
});

// Config Decryption
function decryptConfig(configParam, enableDecryption = true) {
    if (!configParam) return {};
    try {
        const config = JSON.parse(Buffer.from(configParam, 'base64').toString('utf-8'));
        if (enableDecryption && config.encrypted) {
            try {
                const decrypted = decrypt(config.encrypted);
                try {
                    config.encrypted = JSON.parse(decrypted);
                } catch (error) {
                    console.log('Failed to parse decryption: ' + error.message);
                }
            } catch (error) {
                console.error('Failed to decrypt config: ' + error.message);
            }
        }
        return config;
    } catch (error) {
        console.error('Failed to parse config: ' + error.message);
        return {};
    }
}

// Stremio Addon Manifest Route
app.get('/:config/manifest.json', (req, res) => {
    const userConfig = decryptConfig(req.params.config, false);

    res.json({
        id: 'youtubio.elfhosted.com',
        version: '0.1.0',
        name: 'YouTube',
        description: 'Watch YouTube videos, subscriptions, watch later, and history in Stremio.',
        resources: ['catalog', 'stream', 'meta'],
        types: ['movie', 'channel'],
        idPrefixes: [prefix],
        catalogs: (userConfig.catalogs?.map(c => {
            c.extra = [ { name: 'skip', isRequired: false } ];
            return c;
        }) ?? [
            { type: 'movie', id: ':ytrec', name: 'Discover', extra: [ { name: 'skip', isRequired: false } ] },
            { type: 'movie', id: ':ytsubs', name: 'Subscriptions', extra: [ { name: 'skip', isRequired: false } ] },
            { type: 'movie', id: ':ytwatchlater', name: 'Watch Later', extra: [ { name: 'skip', isRequired: false } ] },
            { type: 'movie', id: ':ythistory', name: 'History', extra: [ { name: 'skip', isRequired: false } ] }
        ]).concat([
            // Add search unless explicitly disabled
            ...(userConfig.search === false ? [] : [
                { type: 'movie', id: ':ytsearch', name: 'YouTube', extra: [
                    { name: 'search', isRequired: true },
                    { name: 'skip', isRequired: false }
                ] },
                { type: 'channel', id: ':ytsearch_channel', name: 'YouTube', extra: [
                    { name: 'search', isRequired: true },
                    { name: 'skip', isRequired: false }
                ] }
            ])
        ]),
        behaviorHints: {
            configurable: true
        }
    });
});

// Stremio Addon Catalog Route
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    const channel = req.params.type === 'channel';
    const query = Object.fromEntries(new URLSearchParams(req.params.extra));
    const skip = parseInt(query?.skip ?? 0);

    let command;
    // YT-DLP Search
    if ([':ytsearch'].includes(req.params.id)) {
        if (!query?.search) return res.json({ metas: [] });
        command = `ytsearch100:${query.search}`;
    // Channel Search
    } else if (channel && [':ytsearch_channel'].includes(req.params.id)) {
        if (!query?.search) return res.json({ metas: [] });
        command = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(query.search)}`;
    // YT-DLP Playlists
    } else if (req.params.id.startsWith(":") && [':ytfav', ':ytwatchlater', ':ytsubs', ':ythistory', ':ytrec', ':ytnotif'].includes(req.params.id)) {
        command = req.params.id;
    // Channels
    } else if ( (command = req.params.id.match(/@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]/)) ) {
        command = `https://www.youtube.com/${command[0]}/videos`;
    // Playlists
    } else if ( (command = req.params.id.match(/PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})/)) ) {
        command = `https://www.youtube.com/playlist?list=${command[0]}`;
    // Saved Channel Search
    } else if (channel) {
        command = `https://www.youtube.com/results?sp=EgIQAg%253D%253D&search_query=${encodeURIComponent(req.params.id)}`;
    // Saved YT-DLP Search
    } else {
        command = `ytsearch100:${req.params.id}`;
    }

    return res.json({ metas:
        ((await runYtDlpWithConfig(req.params.config, [
            command,
            '--flat-playlist',
            '--dump-single-json',
            '--playlist-start', `${skip + 1}`,
            '--playlist-end', `${skip + 100}`
        ])).entries ?? []).map(video => 
            video.id ? {
                id: `${prefix}${channel ? video.uploader_id : video.id}`,
                type: req.params.type,
                name: video.title ?? 'Unknown Title',
                poster: `${
                    channel ? req.get('host').includes('localhost') ? 'http' : 'https' + ':' : ''
                }${
                    video.thumbnail ?? video.thumbnails?.at(-1)?.url
                }`,
                posterShape: channel ? 'square' : 'landscape',
                description: video.description,
                releaseInfo: video.upload_date?.substring(0, 4)
            } : null
        ).filter(meta => meta !== null) });
});

// Stremio Addon Meta Route
app.get('/:config/meta/:type/:id.json', async (req, res) => {
    if (!req.params.id.startsWith?.(prefix)) return res.json({ meta: {} });
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const channel = req.params.type === 'channel';
    const videoId = req.params.id.slice(prefix.length);
    const manifestUrl = encodeURIComponent(`${protocol}://${host}/${req.params.config}/manifest.json`);

    const video = await runYtDlpWithConfig(req.params.config, [
        `https://www.youtube.com/${req.params.type === 'movie' ? 'watch?v=' : ''}${videoId}`,
        '-j',
        ...(req.params.config?.markWatchedOnLoad ? ['--mark-watched'] : [])
    ]);
    const title = video.title ?? 'Unknown Title';
    const thumbnail = `${channel ? protocol + ':' : ''}${video.thumbnail ?? video.thumbnails?.at(-1)?.url}`;
    const released = new Date((video.timestamp ?? 0) * 1000).toISOString();
    return res.json({
        meta: video.id ? {
            id: req.params.id,
            type: req.params.type,
            name: title,
            genres: video.tags,
            poster: thumbnail,
            posterShape: channel ? 'square' : 'landscape',
            background: thumbnail,
            description: video.description,
            releaseInfo: video.upload_date?.substring(0, 4),
            released: released,
            videos: [{
                id: req.params.id,
                title: title,
                released: released,
                thumbnail: thumbnail,
                streams: [
                    ...(req.params.type === 'movie' ? [
                        {
                            name: 'YT-DLP Player',
                            url: video.url,
                            description: 'Click to watch the scraped video from YT-DLP',
                            subtitles: Object.entries(video.subtitles ?? {}).map(([k, v]) => {
                                const srt = v.find(x => x.ext == 'srt') ?? v[0] ?? {};
                                return srt ? {
                                    id: srt.name,
                                    url: srt.url,
                                    lang: k
                                } : null;
                            }).concat(
                                Object.entries(video.automatic_captions ?? {}).map(([k, v]) => {
                                    const srt = v.find(x => x.ext == 'srt') ?? v[0];
                                    return srt ? {
                                        id: `Auto ${srt.name}`,
                                        url: srt.url,
                                        lang: k
                                    } : null;
                                })
                            ).filter(srt => srt !== null),
                            behaviorHints: {
                                ...(video.protocol !== 'https' || video.video_ext !== 'mp4' ? { notWebReady: true } : {}),
                                videoSize: video.filesize_approx,
                                filename: video.filename
                            }
                        }, {
                            name: 'Stremio Player',
                            ytId: videoId,
                            description: 'Click to watch using Stremio\'s built-in YouTube Player'
                        }, {
                            name: 'YouTube Player',
                            externalUrl: video.original_url,
                            description: 'Click to watch in the official YouTube Player'
                        }
                    ] : []), {
                        name: 'View Channel',
                        externalUrl: `stremio:///discover/${manifestUrl}/movie/${encodeURIComponent(video.uploader_id)}`,
                        description: 'Click to open the channel as a Catalog'
                    }
                ],
                overview: video.description
            }],
            runtime: `${Math.floor((video.duration ?? 0) / 60)} min`,
            language: video.language,
            website: video.original_url,
            behaviorHints: {
                defaultVideoId: req.params.id
            }
        } : {}
    });
});

// Configuration Page
app.get(['/', '/:config?/configure'], (req, res) => {
    const host = req.get('host');
    const protocol = host.includes('localhost') ? 'http' : 'https';
    const userConfig = decryptConfig(req.params.config, false);
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>YouTubio | ElfHosted</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; text-align: center; padding: 40px; background: #f4f4f8; color: #333; }
                .container { max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
                h1 { color: #d92323; }
                p { font-size: 1.1em; line-height: 1.6; }
                textarea { width: 100%; height: 150px; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; resize: vertical; }
                #playlist-table th, #playlist-table td { border: 1px solid #ccc; padding: 5px; text-align: left; }
                #playlist-table input { width: 100%; box-sizing: border-box; }
                .install-button { display: inline-block; margin-top: 20px; padding: 15px 30px; background-color: #5835b0; color: white; text-decoration: none; font-size: 1.2em; border-radius: 5px; transition: background-color 0.3s; border: none; cursor: pointer; }
                .install-button:hover { background-color: #4a2c93; }
                .install-button:disabled { background-color: #ccc; cursor: not-allowed; }
                .action-button { padding: 5px 10px; font-size: 0.9em; }
                .url-input { width: 100%; padding: 10px; margin-top: 15px; border-radius: 4px; border: 1px solid #ccc; box-sizing: border-box; }
                .instructions { text-align: left; margin-top: 25px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .instructions summary { font-weight: bold; cursor: pointer; }
                .instructions ul { padding-left: 20px; }
                .instructions li { margin-bottom: 8px; }
                #results { margin-top: 20px; }
                .error { color: #d92323; margin-top: 10px; }
                .loading { color: #666; font-style: italic; }
                .settings-section { text-align: left; margin-top: 20px; padding: 15px; border: 1px solid #ddd; border-radius: 5px; background: #f9f9f9; }
                .toggle-container { display: flex; align-items: center; margin: 10px 0; }
                .toggle-container input[type="checkbox"] { margin-right: 10px; }
                .toggle-container label { font-weight: normal; cursor: pointer; }
                .setting-description { font-size: 0.9em; color: #666; margin-top: 5px; line-height: 1.4; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>YouTubio | ElfHosted</h1>
                ${process.env.EMBED || ""}
                <form id="config-form">
                    <div class="settings-section">
                        <h3>Cookies</h3>
                        <button type="button" class="install-button action-button" id="google-login">Login with Google</button>
                        <p id="auth-status"></p>
                    </div>
                    <div class="settings-section">
                        <h3>Playlists</h3>
                        <div style="margin-bottom: 10px;">
                            <button type="button" id="add-defaults" class="install-button action-button">Add Defaults</button>
                            <button type="button" id="remove-defaults" class="install-button action-button">Remove Defaults</button>
                            <button type="button" id="add-playlist" class="install-button action-button">Add Playlist</button>
                        </div>
                        <table id="playlist-table" style="width:100%;border-collapse:collapse;">
                            <thead>
                                <tr>
                                    <th>Type</th>
                                    <th>Playlist ID / URL</th>
                                    <th>Name</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody></tbody>
                        </table>
                    </div>
                    <div class="settings-section" id="addon-settings">
                        <h3>Settings</h3>
                        <div class="toggle-container">
                            <input type="checkbox" id="markWatchedOnLoad" name="markWatchedOnLoad">
                            <label for="markWatchedOnLoad">Mark watched on load</label>
                            <div class="setting-description">
                                When enabled, videos will be automatically marked as watched in your YouTube history when you open them in Stremio. This helps keep your YouTube watch history synchronized.
                            </div>
                        </div>
                        <div class="toggle-container">
                            <input type="checkbox" id="search" name="search" checked>
                            <label for="search">Allow searching</label>
                            <div class="setting-description">
                                When enabled, Stremio's search feature will also return YouTube results.
                            </div>
                        </div>
                    </div>
                    <button type="submit" class="install-button" id="submit-btn">Generate Install Link</button>
                    <div id="error-message" class="error" style="display:none;"></div>
                </form>
                <div id="results" style="display:none;">
                    <h2>Install your addon</h2>
                    <a href="#" target="_blank" id="install-stremio" class="install-button">Stremio</a>
                    <a href="#" target="_blank" id="install-web" class="install-button">Stremio Web</a>
                    <a id="copy-btn" class="install-button">Copy URL</a>
                    <input type="text" id="install-url" style="display: none;" readonly class="url-input">
                </div>
            </div>
            <script>
                const submitBtn = document.getElementById('submit-btn');
                const errorDiv = document.getElementById('error-message');
                const installStremio = document.getElementById('install-stremio');
                const installUrlInput = document.getElementById('install-url');
                const installWeb = document.getElementById('install-web');
                const playlistTableBody = document.querySelector('#playlist-table tbody');
                const defaultPlaylists = [
                    { type: 'movie', id: ':ytrec', name: 'Discover' },
                    { type: 'movie', id: ':ytsubs', name: 'Subscriptions' },
                    { type: 'movie', id: ':ytwatchlater', name: 'Watch Later' },
                    { type: 'movie', id: ':ythistory', name: 'History' }
                ];
                let playlists = ${userConfig.catalogs ? JSON.stringify(userConfig.catalogs) : "JSON.parse(JSON.stringify(defaultPlaylists))"};
                let encrypted = ${JSON.stringify(userConfig.encrypted || '')};
                document.getElementById('markWatchedOnLoad').checked = ${userConfig.markWatchedOnLoad === true ? 'true' : 'undefined'};
                document.getElementById('search').checked = ${userConfig.search === false ? 'false' : 'undefined'};
                const authStatus = document.getElementById('auth-status');
                const googleLogin = document.getElementById('google-login');
                if (encrypted) {
                    googleLogin.textContent = 'Re-login with Google';
                    authStatus.textContent = 'Authenticated';
                } else {
                    googleLogin.textContent = 'Login with Google';
                    authStatus.textContent = 'Not authenticated';
                }
                function extractPlaylistId(input) {
                    let match;
                        // Channel URL
                    if (( match = input.match(/@[a-zA-Z0-9][a-zA-Z0-9\._-]{1,28}[a-zA-Z0-9]/) ) ||
                        // Playlist ID / Playlist URL
                        ( match = input.match(/PL([0-9A-F]{16}|[A-Za-z0-9_-]{32})/) ) ||
                        // Search URL
                        ( match = input.match(/(?<=search_query=)[^&]+/) ))
                        return match[0].trim();
                    // Search
                    return input.trim();
                }
                function renderPlaylists() {
                    playlistTableBody.innerHTML = '';
                    playlists.forEach((pl, index) => {
                        const row = document.createElement('tr');
                        // Type
                        const typeCell = document.createElement('td');
                        const typeInput = document.createElement('input');
                        typeInput.value = pl.type;
                        typeInput.addEventListener('input', () => pl.type = typeInput.value.trim());
                        typeCell.appendChild(typeInput);
                        // ID
                        const idCell = document.createElement('td');
                        const idInput = document.createElement('input');
                        idInput.value = pl.id;
                        idInput.addEventListener('change', () => pl.id = extractPlaylistId(idInput.value));
                        idCell.appendChild(idInput);
                        // Name
                        const nameCell = document.createElement('td');
                        const nameInput = document.createElement('input');
                        nameInput.value = pl.name;
                        nameInput.addEventListener('input', () => pl.name = nameInput.value.trim());
                        nameCell.appendChild(nameInput);
                        // Actions
                        const actionsCell = document.createElement('td');
                        const upBtn = document.createElement('button');
                        upBtn.textContent = '↑';
                        upBtn.addEventListener('click', () => {
                            if (index > 0) {
                                [playlists[index - 1], playlists[index]] = [playlists[index], playlists[index - 1]];
                                renderPlaylists();
                            }
                        });
                        const downBtn = document.createElement('button');
                        downBtn.textContent = '↓';
                        downBtn.addEventListener('click', () => {
                            if (index < playlists.length - 1) {
                                [playlists[index + 1], playlists[index]] = [playlists[index], playlists[index + 1]];
                                renderPlaylists();
                            }
                        });
                        const removeBtn = document.createElement('button');
                        removeBtn.textContent = 'Remove';
                        removeBtn.addEventListener('click', () => {
                            playlists.splice(index, 1);
                            renderPlaylists();
                        });
                        actionsCell.appendChild(upBtn);
                        actionsCell.appendChild(downBtn);
                        actionsCell.appendChild(removeBtn);
                        row.appendChild(typeCell);
                        row.appendChild(idCell);
                        row.appendChild(nameCell);
                        row.appendChild(actionsCell);
                        playlistTableBody.appendChild(row);
                    });
                }
                document.getElementById('add-playlist').addEventListener('click', () => {
                    playlists.push({ type: 'movie', id: '', name: '' });
                    renderPlaylists();
                });
                document.getElementById('add-defaults').addEventListener('click', () => {
                    playlists = [...playlists, ...defaultPlaylists];
                    renderPlaylists();
                });
                document.getElementById('remove-defaults').addEventListener('click', () => {
                    playlists = playlists.filter(pl => !defaultPlaylists.some(def => def.id === pl.id));
                    renderPlaylists();
                });
                renderPlaylists();
                document.getElementById('google-login').addEventListener('click', () => {
                    const stateString = btoa(JSON.stringify({
                        catalogs: playlists,
                        ...Object.fromEntries(
                            Array.from(document.getElementById('addon-settings').querySelectorAll("input"))
                                .map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])
                        )
                    }));
                    window.location.href = '/auth?state=' + encodeURIComponent(stateString);
                });
                document.getElementById('config-form').addEventListener('submit', async function(event) {
                    event.preventDefault();
                    if (!encrypted) {
                        errorDiv.textContent = "You must login with Google to use this addon";
                        errorDiv.style.display = 'block';
                        return;
                    }
                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Generating...';
                    errorDiv.style.display = 'none';
                    try {
                        const configString = btoa(JSON.stringify({
                            encrypted: encrypted,
                            catalogs: playlists,
                            ...Object.fromEntries(
                                Array.from(document.getElementById('addon-settings').querySelectorAll("input"))
                                    .map(x => [x.name, x.type === 'checkbox' ? x.checked : x.value])
                            )
                        }));
                        installStremio.href = \`stremio://${host}/\${configString}/manifest.json\`;
                        installUrlInput.value = \`${protocol}://${host}/\${configString}/manifest.json\`;
                        installWeb.href = \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(installUrlInput.value)}\`;
                        document.getElementById('results').style.display = 'block';
                    } catch (error) {
                        errorDiv.textContent = error.message;
                        errorDiv.style.display = 'block';
                    } finally {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Generate Install Link';
                    }
                });
                document.getElementById('copy-btn').addEventListener('click', async function() {
                    await navigator.clipboard.writeText(installUrlInput.value);
                    this.textContent = 'Copied!';
                    setTimeout(() => { this.textContent = 'Copy URL'; }, 2000);
                });
            </script>
        </body>
        </html>
    `);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error('Express error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Addon server running on port ${PORT}`);
    if (!process.env.ENCRYPTION_KEY) {
        console.warn('WARNING: Using random encryption key. Set ENCRYPTION_KEY environment variable for production.');
        console.log('Generated key (base64):', ENCRYPTION_KEY.toString('base64'));
    }
    if (process.env.SPACE_HOST) {
        console.log(`Access the configuration page at: https://${process.env.SPACE_HOST}`);
    } else {
        console.log(`Access the configuration page at: http://localhost:${PORT}`);
    }
});