const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { MOVIES } = require('@consumet/extensions');
const ffmpeg = require('ffmpeg-static');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const TMDB_API = '04c35731a5ee918f014970082a0088b1';

// 1. PROXY ENGINE (Ad-Stripping)
app.get('/proxy', async (req, res) => {
    let targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing URL');
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');

    const isM3U8 = targetUrl.includes('.m3u8');
    const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': '*/*', 'Origin': new URL(targetUrl).origin, 'Referer': new URL(targetUrl).origin + '/' };
    const currentHost = req.get('host');
    const protocol = req.protocol;

    try {
        if (isM3U8) {
            const response = await axios.get(targetUrl, { headers: HEADERS });
            let m3u8Text = response.data;
            const lines = m3u8Text.split('\n');
            const newLines = [];
            for (let line of lines) {
                line = line.trim();
                if (line.startsWith('#EXTINF:')) {
                    const duration = parseFloat(line.split(':')[1].split(',')[0]);
                    if (duration < 6.0) continue; // Strip ads
                }
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
            const range = req.headers.range;
            if (range) HEADERS['Range'] = range;
            const response = await axios({ method: 'GET', url: targetUrl, headers: HEADERS, responseType: 'stream' });
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/mp4');
            if (response.headers['content-range']) { res.setHeader('Content-Range', response.headers['content-range']); res.status(206); }
            res.setHeader('Access-Control-Allow-Origin', '*');
            response.data.pipe(res);
        }
    } catch (error) { res.status(500).send('Stream blocked'); }
});

// 2. DISCOVERY (Categories, Dubbed, Hubs, Coming Soon)
app.get('/api/discover', async (req, res) => {
    try {
        const { type = 'movie', category, page = 1, company } = req.query;
        let url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&page=${page}&sort_by=popularity.desc`;

        if (company) url = `https://api.themoviedb.org/3/discover/${type}?api_key=${TMDB_API}&with_companies=${company}&page=${page}&sort_by=popularity.desc`;
        else if (category === 'trending') url = `https://api.themoviedb.org/3/trending/${type}/week?api_key=${TMDB_API}&page=${page}`;
        else if (category === 'dubbed') url += `&with_original_language=ja|ko|zh|es|fr|hi|tr&sort_by=popularity.desc`;
        else if (category === 'kdrama') url = `https://api.themoviedb.org/3/discover/tv?api_key=${TMDB_API}&with_origin_country=KR&sort_by=popularity.desc&page=${page}`;
        else if (category === 'upcoming') url = `https://api.themoviedb.org/3/movie/upcoming?api_key=${TMDB_API}&page=${page}`;

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

// 4. LIVE SPORTS (ESPN)
app.get('/api/sports', async (req, res) => {
    try {
        const espnRes = await axios.get('https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard', { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 8000 });
        const events = espnRes.data.events || [];
        const live = []; const upcoming = [];

        events.forEach(event => {
            const comp = event.competitions[0];
            const home = comp.competitors.find(c => c.homeAway === 'home');
            const away = comp.competitors.find(c => c.homeAway === 'away');
            const match = {
                id: event.id, date: event.date, status: event.status.type.shortDetail,
                homeTeam: home?.team.displayName || 'TBD', awayTeam: away?.team.displayName || 'TBD',
                homeScore: home?.score || "0", awayScore: away?.score || "0",
                homeLogo: home?.team.logo || '', awayLogo: away?.team.logo || ''
            };
            if (event.status.type.state === 'in') live.push(match);
            else if (event.status.type.state === 'pre') upcoming.push(match);
        });
        res.json({ live, upcoming });
    } catch (error) { res.status(500).json({ error: "Sports API Error" }); }
});

// 5. STREAM EXTRACTOR (Forces Native HLS Playback)
app.get('/api/stream', async (req, res) => {
    const { id, type, title, season = 1, episode = 1 } = req.query;
    const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

    try {
        const provider = new MOVIES.FlixHQ();
        const search = await provider.search(title);
        if (search.results && search.results.length > 0) {
            const info = await provider.fetchMediaInfo(search.results[0].id);
            if (info.episodes && info.episodes.length > 0) {
                let epId = info.episodes[0].id;
                if (type === 'tv') {
                    const ep = info.episodes.find(e => e.season == season && e.number == episode);
                    if (ep) epId = ep.id;
                }
                const sources = await provider.fetchEpisodeSources(epId);
                if (sources.sources && sources.sources.length > 0) {
                    const rawUrl = sources.sources.find(s => s.isM3U8)?.url || sources.sources[0].url;
                    return res.json({ success: true, mode: 'native', streamUrl: `${proxyBase}${encodeURIComponent(rawUrl)}` });
                }
            }
        }
    } catch (e) { }

    try {
        let vidLinkUrl = `https://vidlink.pro/api/b/${type}/${id}`;
        if (type === 'tv') vidLinkUrl += `/${season}/${episode}`;
        const vidLinkRes = await axios.get(vidLinkUrl, { timeout: 4000 });
        if (vidLinkRes.data?.stream?.playlist) {
            return res.json({ success: true, mode: 'native', streamUrl: `${proxyBase}${encodeURIComponent(vidLinkRes.data.stream.playlist)}` });
        }
    } catch (e) { }

    res.status(404).json({ error: "No stream found." });
});

// 6. DOWNLOAD ENGINE (Converts HLS to MP4)
app.get('/api/download', async (req, res) => {
    let targetUrl = req.query.url;
    const title = req.query.title || 'StreamNova-Movie';
    if (!targetUrl) return res.status(400).send('Missing URL');
    if (!targetUrl.startsWith('http')) targetUrl = Buffer.from(targetUrl, 'base64').toString('utf8');

    try {
        res.setHeader('Content-Disposition', `attachment; filename="${title}.mp4"`);
        res.setHeader('Content-Type', 'video/mp4');
        const ffmpegProcess = spawn(ffmpeg, [
            '-i', targetUrl, '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
            '-movflags', 'frag_keyframe+empty_moov', 'pipe:1'
        ]);
        ffmpegProcess.stdout.pipe(res);
        ffmpegProcess.on('error', () => res.end());
        ffmpegProcess.on('close', () => res.end());
    } catch (error) { res.status(500).send('Download failed'); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 SERVER running on port ${PORT}`));
