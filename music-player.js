(function () {
    // ==========================================
    // NERV 插入栓音频终端配置
    // ==========================================
    const API_BASE = "https://api地址"; // 网易云自建 API 地址
    const PLAYLIST_ID = "歌单";            // 网易云歌单 ID
    const VIP_COOKIE = localStorage.getItem("VIP_COOKIE") || ""; 
    // ==========================================

    const statusText = document.getElementById("status-text");
    const songNameEl = document.getElementById("song-name");
    
    // Lyrics & Progress
    const progressEl = document.getElementById("progress");
    const lyricsTextEl = document.getElementById("lyrics-text");
    const lyricsWrapEl = document.querySelector(".ep-lyrics-wrap");
    
    // Controls
    const playBtn = document.getElementById("play-btn");
    const prevBtn = document.getElementById("prev-btn");
    const nextBtn = document.getElementById("next-btn");
    const listBtn = document.getElementById("list-toggle-btn");
    const volBtn = document.getElementById("vol-toggle-btn");
    const volWrap = document.getElementById("ep-vol-wrap");
    const volInput = document.getElementById("volume");
    const volValueEl = document.getElementById("volume-value");
    const volIcon = document.getElementById("vol-icon");
    const playlistWrap = document.getElementById("ep-playlist-wrap");
    const playlistEl = document.getElementById("playlist");
    const audio = document.getElementById("audio");

    let tracks = [];
    let lyricsData = [];
    let currentIndex = -1;
    let isPlaying = false;

    function setStatus(message, isError) {
        if(statusText) {
            statusText.textContent = message;
            statusText.className = "ep-status " + (isError ? "status-error" : "status-ok");
        }
    }

    async function fetchJsonApi(path, params = {}) {
        if (VIP_COOKIE) params.cookie = VIP_COOKIE;
        // 支持传递参数的通用网络请求
        const url = new URL(API_BASE + path);
        Object.keys(params).forEach(k => url.searchParams.append(k, params[k]));
        
        try {
            const response = await fetch(url, { method: "GET" });
            if (!response.ok) throw new Error("HTTP " + response.status);
            return await response.json();
        } catch (e) {
            // GET 发生 URI 太长错误时，对于 NetEase API 可降级使用 POST
            const form = new URLSearchParams(params);
            const response = await fetch(API_BASE + path, {
                method: "POST",
                headers: {"Content-Type": "application/x-www-form-urlencoded"},
                body: form
            });
            if (!response.ok) throw new Error("HTTP " + response.status);
            return await response.json();
        }
    }

    async function loadPlaylist() {
        setStatus("ACCESSING TERMINAL AUDIO...", false);
        const detail = await fetchJsonApi("/playlist/detail", { id: PLAYLIST_ID });
        const list = (detail && detail.playlist && detail.playlist.tracks) ? detail.playlist.tracks : [];

        tracks = list.map(item => {
            const artist = Array.isArray(item.ar) ? item.ar.map(p => p.name).join(" / ") : "UNKNOWN";
            return { id: item.id, name: item.name, artist: artist, duration: (item.dt || 0) / 1000 };
        });

        if (!tracks.length) throw new Error("歌单为空，API 返回数据异常");

        renderPlaylist();
        setStatus("MODULE CONNECTED: " + tracks.length + " FILES", false);
        await playByIndex(0, false);
    }

    function renderPlaylist() {
        playlistEl.innerHTML = "";
        tracks.forEach((track, idx) => {
            const li = document.createElement("li");
            li.innerHTML = `
                <span class="index">${String(idx + 1).padStart(2, "0")}</span>
                <div class="meta">
                    <span class="name">${track.name}</span>
                    <span class="artist">${track.artist}</span>
                </div>
            `;
            li.addEventListener("click", () => {
                playByIndex(idx, true).catch(err => setStatus("Playback Failed: " + err.message, true));
            });
            playlistEl.appendChild(li);
        });
    }

    async function fetchAudioLrc(songId) {
        lyricsData = [];
        lyricsTextEl.innerHTML = "SYNCHRONIZING MODULE...";
        try {
            const data = await fetchJsonApi("/lyric", { id: songId });
            let tlyricMap = {};

            // 解析翻译歌词
            if (data && data.tlyric && data.tlyric.lyric) {
                const tlines = data.tlyric.lyric.split("\n");
                for (let line of tlines) {
                    const match = line.match(/\[(\d+):(\d+\.\d+|0+)\](.*)/);
                    if (match) {
                        const s = parseInt(match[1]) * 60 + parseFloat(match[2]);
                        const txt = match[3].trim();
                        if (txt) tlyricMap[s.toFixed(2)] = txt; // 以两位小数秒数为键
                    }
                }
            }

            if (data && data.lrc && data.lrc.lyric) {
                const lines = data.lrc.lyric.split("\n");
                for(let line of lines) {
                    const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
                    if(match) {
                        const s = parseInt(match[1]) * 60 + parseFloat(match[2]);
                        const txt = match[3].trim();
                        const trans = tlyricMap[s.toFixed(2)] || "";
                        if(txt) lyricsData.push({ time: s, text: txt, trans: trans });
                    }
                }
                
                if(lyricsData.length === 0) {
                    lyricsTextEl.innerHTML = "- PURE AUDIO -";
                } else {
                    lyricsTextEl.innerHTML = "LYRICS ACTIVATED / READY";
                }
            } else {
                lyricsTextEl.innerHTML = "- NO LYRIC MODULE -";
            }
        } catch(e) {
            lyricsTextEl.innerHTML = "- LYRIC ERROR -";
        }
    }

    function executeLyricSync(time) {
        if (!lyricsData.length) return;
        let cText = "";
        let cTrans = "";
        for (let i = 0; i < lyricsData.length; i++) {
            if (time >= lyricsData[i].time) {
                cText = lyricsData[i].text;
                cTrans = lyricsData[i].trans;
            } else break;
        }
        
        // 只有当原文内容发生变化时才更新 DOM，以免重复渲染
        if (cText && lyricsTextEl.dataset.currentText !== cText) {
            lyricsTextEl.dataset.currentText = cText;
            if (cTrans) {
                lyricsTextEl.innerHTML = `${cText} <br/> <span style="font-size:0.85em;color:#aaa;">${cTrans}</span>`;
            } else {
                lyricsTextEl.textContent = cText;
            }
        }
    }

    async function playByIndex(index, autoplay) {
        if (!tracks.length) return;
        const safeIndex = (index + tracks.length) % tracks.length;
        const track = tracks[safeIndex];

        // 获取音频 (VIP 可能需要 cookie。level 尽可以请求 exhigh 等以测试高音质)
        const result = await fetchJsonApi("/song/url/v1", { id: track.id, level: "exhigh" });
        const url = (result && result.data && result.data[0]) ? result.data[0].url : "";

        if (!url || typeof url !== 'string' || url.includes("error")) {
            setStatus("AUDIO BLOCKED. URL抓取失败. 若无版权/为VIP音乐请在VIP_COOKIE中配置网易云网页版Cookie。", true);
            throw new Error("Missing Audio URI or Blocked Due To VIP.");
        }

        currentIndex = safeIndex;
        songNameEl.textContent = track.name;
        // 如果歌名超出了容器高度，则添加滚动类
        songNameEl.classList.remove("scroll");
        setTimeout(() => {
            if (songNameEl.scrollHeight > 75) { /* ep-track-wrap is 75px max height */
                songNameEl.classList.add("scroll");
            }
        }, 10);
        document.querySelectorAll("#playlist li").forEach((li, i) => li.classList.toggle("active", i === currentIndex));
        progressEl.value = "0";
        progressEl.style.setProperty("--progress", "0%");
        
        audio.src = url;
        audio.load();
        
        // 抓取并同步歌词
        fetchAudioLrc(track.id);

        if (autoplay) {
            await Promise.all([audio.play()]);
            isPlaying = true;
            playBtn.innerHTML = '<i class="fas fa-pause"></i>';
            if (lyricsWrapEl) lyricsWrapEl.style.opacity = "1";
        } else {
            isPlaying = false;
            playBtn.innerHTML = '<i class="fas fa-play"></i>';
            if (lyricsWrapEl) lyricsWrapEl.style.opacity = "0";
        }
    }

    function togglePlay() {
        if (!audio.src) return;
        if (isPlaying) { 
            audio.pause(); 
            isPlaying = false; 
            playBtn.innerHTML = '<i class="fas fa-play"></i>'; 
            if (lyricsWrapEl) lyricsWrapEl.style.opacity = "0";
        } else { 
            audio.play().then(() => { 
                isPlaying = true; 
                playBtn.innerHTML = '<i class="fas fa-pause"></i>'; 
                if (lyricsWrapEl) lyricsWrapEl.style.opacity = "1";
            }); 
        }
    }

    function applyVolumeFromSlider() {
        if (!volInput || !audio) return;
        const val = Math.max(0, Math.min(100, Number(volInput.value) || 0));
        volInput.value = String(val);
        if (volValueEl) volValueEl.textContent = val + "%";
        if (volWrap) {
            volWrap.style.setProperty("--vol-percent", val + "%");
            volWrap.style.setProperty("--vol-val", val);
        }

        if (val === 0) {
            audio.volume = 0;
            audio.muted = true;
            if (volIcon) volIcon.className = "fas fa-volume-xmark";
            return;
        }

        audio.muted = false;
        audio.volume = Math.pow(val / 100, 2);
        if (volIcon) {
            volIcon.className = val < 40 ? "fas fa-volume-low" : "fas fa-volume-high";
        }
    }

    function changeVolumeByStep(step) {
        if (!volInput) return;
        const current = Number(volInput.value) || 0;
        const next = Math.max(0, Math.min(100, current + step));
        volInput.value = String(next);
        applyVolumeFromSlider();
    }

    function bindEvents() {
        playBtn.addEventListener("click", togglePlay);
        
        if (listBtn && playlistWrap) {
            listBtn.addEventListener("click", (e) => {
                e.stopPropagation(); // 阻止冒泡，以免被 document click 捕获到直接关闭
                playlistWrap.classList.toggle("show");
                if (volWrap && volWrap.classList.contains("show")) volWrap.classList.remove("show");
            });
        }
        
        if (volBtn && volWrap) {
            volBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                volWrap.classList.toggle("show");
                if (playlistWrap && playlistWrap.classList.contains("show")) playlistWrap.classList.remove("show");
            });
        }

        // 点击空白处关闭歌单或音量调节
        document.addEventListener("click", (e) => {
            if (playlistWrap && playlistWrap.classList.contains("show") && !playlistWrap.contains(e.target)) {
                playlistWrap.classList.remove("show");
            }
            if (volWrap && volWrap.classList.contains("show") && !volWrap.contains(e.target)) {
                volWrap.classList.remove("show");
            }
        });

        if (volInput && audio) {
            applyVolumeFromSlider();
            volInput.addEventListener("input", applyVolumeFromSlider);
        }

        if (volWrap) {
            volWrap.addEventListener("wheel", (event) => {
                if (!volWrap.classList.contains("show")) return;
                event.preventDefault();
                const step = event.deltaY < 0 ? 4 : -4;
                changeVolumeByStep(step);
            }, { passive: false });
        }
        
        prevBtn.addEventListener("click", () => {
            if (tracks.length) playByIndex(currentIndex - 1, true).catch(e => console.error(e));
        });
        nextBtn.addEventListener("click", () => {
            if (tracks.length) playByIndex(currentIndex + 1, true).catch(e => console.error(e));
        });
        audio.addEventListener("ended", () => {
            if (tracks.length) playByIndex(currentIndex + 1, true);
        });

        audio.addEventListener("timeupdate", () => {
            if (!audio.duration) return;
            const percentage = (audio.currentTime / audio.duration) * 100;
            progressEl.value = String(Math.max(0, Math.min(100, percentage)));
            progressEl.style.setProperty("--progress", percentage + "%");
            executeLyricSync(audio.currentTime);
        });

        progressEl.addEventListener("input", () => {
            if (!audio.duration) return;
            audio.currentTime = (Number(progressEl.value) / 100) * audio.duration;
        });
    }

    function startSyncAnimation() {
        // 播放器头部已改为固定文案 EVA 01，保留空函数避免改动初始化流程。
    }

    setStatus("ENIGMA AUDIO SYSTEM ONLINE", false);
    bindEvents();
    startSyncAnimation();
    loadPlaylist().catch(e => setStatus("LOAD FAILURE: " + e.message, true));

})();