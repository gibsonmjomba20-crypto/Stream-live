const express = require('express');
const axios = require('axios');
const cloudscraper = require('cloudscraper');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

// 1. UNIVERSAL BYPASS PROXY (Uses Cloudscraper to bypass Cloudflare)
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');

    const currentHost = req.get('host');
    const protocol = req.protocol;
    const isM3U8 = targetUrl.includes('.m3u8');

    // Fake browser headers to trick the origin server
    const HEADERS = { 
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*', 
        'Origin': new URL(targetUrl).origin, 
        'Referer': new URL(targetUrl).origin + '/' 
    };

    try {
        if (isM3U8) {
            // Use cloudscraper to bypass Cloudflare JS challenges
            let m3u8Text = await cloudscraper({
                uri: targetUrl,
                method: 'GET',
                headers: HEADERS,
                encoding: null
            }).catch(() => null);

            // Fallback to Axios if cloudscraper fails
            if (!m3u8Text) {
                const response = await axios.get(targetUrl, { headers: HEADERS });
                m3u8Text = response.data;
            } else {
                m3u8Text = m3u8Text.toString('utf8');
            }

            const lines = m3u8Text.split('\n');
            const newLines = [];
            for (let line of lines) {
                line = line.trim();
                // Ad-stripping: remove segments shorter than 6 seconds
                if (line.startsWith('#EXTINF:')) {
                    const duration = parseFloat(line.split(':')[1].split(',')[0]);
                    if (duration < 6.0) continue; 
                }
                // Rewrite URL to go through our proxy
                if (line && !line.startsWith('#')) {
                    const absoluteUrl = new URL(line, targetUrl).href;
                    const encodedUrl = Buffer.from(absoluteUrl).toString('base64');
                    line = `${protocol}://${currentHost}/proxy?url=${encodedUrl}`;
                }
                newLines.push(line);
            }
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            return res.send(newLines.join('\n'));
        } else {
            // Stream video chunks (.ts) directly
            const range = req.headers.range;
            if (range) HEADERS['Range'] = range;
            const response = await axios({ method: 'GET', url: targetUrl, headers: HEADERS, responseType: 'stream' });
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
            if (response.headers['content-range']) { res.setHeader('Content-Range', response.headers['content-range']); res.status(206); }
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.data.pipe(res);
        }
    } catch (error) { 
        res.status(500).send('Stream blocked'); 
    }
});

// 2. DISCOVERY (TMDB Data)
app.get('/api/discover', async (req, res) => {
    try {
        const { type = 'movie', category, page = 1, company } = req.query;
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;

        if (category === 'trending') url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        else if (category === 'kdrama') url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&with_origin_country=KR&sort_by=popularity.desc&page=${page}`;
        else if (category === 'dubbed') url += `&with_original_language=ja|ko|zh|fr|es|hi|tr&with_spoken_languages=en`;
        else if (company) url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&with_companies=${company}&page=${page}&sort_by=popularity.desc`;

        const response = await axios.get(url, { timeout: 5000 });
        res.json({ results: response.data.results });
    } catch (error) { res.status(500).json({ error: "API Error" }); }
});

// 3. DETAILS & SEARCH
app.get('/api/details', async (req, res) => {
    try {
        const { id, type } = req.query;
        const url = `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API}&append_to_response=credits,similar,videos`;
        const response = await axios.get(url, { timeout: 5000 });
        res.json(response.data);
    } catch (error) { res.status(500).json({ error: "Failed to load details" }); }
});

app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const response = await axios.get(`https://api.themoviedb.org/3/search/multi?api_key=${TMDB_API}&query=${encodeURIComponent(query)}`, { timeout: 5000 });
        res.json({ results: response.data.results });
    } catch (error) { res.status(500).json({ error: "Search failed" }); }
});

// 4. STREAM WATERFALL
app.get('/api/stream', async (req, res) => {
    const { id, type, title, season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 4000 });
        if (vidLinkRes.data?.stream?.playlist) {
            return res.json({ success: true, mode: 'native', streamUrl: `${proxyBase}${encodeURIComponent(vidLinkRes.data.stream.playlist)}` });
        }
    } catch (e) { }

    let iframeUrls = type === 'movie' 
        ? [`https://vidsrc.to/embed/movie/${id}`, `https://vidsrc.xyz/embed/movie/${id}`]
        : [`https://vidsrc.to/embed/tv/${id}/${season}/${episode}`, `https://vidsrc.xyz/embed/tv/${id}/${season}/${episode}`];

    return res.json({ success: true, mode: 'iframe', iframeUrls: iframeUrls });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 SERVER running on port ${PORT}`));
