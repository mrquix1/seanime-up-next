/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register(function (ctx) {
        var MAX_EXTRA = 40        // safety cap: max extra cards per show
        var REFRESH_MS = 4000     // how often the home screen is re-checked
        var STUCK_MS = 30000      // a run longer than this is considered stuck
        var DEBUG = true
        var SELECTOR = "[data-continue-watching-container] [data-episode-card]"
        var episodeCache = {}
        var mediaMapCache = null

        function log(msg) { if (DEBUG) console.log("up-next: " + msg) }

        // ---------- AniList lookup ----------
        function loadMediaMap() {
            var map = {}
            var collection = $anilist.getAnimeCollection(false)
            var lists = (collection && collection.MediaListCollection && collection.MediaListCollection.lists) || []
            lists.forEach(function (list) {
                ((list && list.entries) || []).forEach(function (entry) {
                    var m = entry && entry.media
                    if (!m) return
                    map[String(m.id)] = {
                        title: (m.title && m.title.userPreferred) || "",
                        image: m.bannerImage || (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || "",
                        releasing: String(m.status) === "RELEASING",
                        nextAiring: (m.nextAiringEpisode && Number(m.nextAiringEpisode.episode)) || 0
                    }
                })
            })
            return map
        }

        function getMediaMap() {
            if (!mediaMapCache) mediaMapCache = loadMediaMap()
            return mediaMapCache
        }

        // ---------- Episode metadata (thumbnails, titles, runtime) ----------
        function getEpisodes(mediaId) {
            if (episodeCache[mediaId]) return Promise.resolve(episodeCache[mediaId])
            return fetch("https://api.ani.zip/mappings?anilist_id=" + mediaId)
                .then(function (res) { return Promise.resolve(res.json()) })
                .then(function (data) {
                    var eps = (data && data.episodes) || {}
                    episodeCache[mediaId] = eps
                    return eps
                }, function (err) {
                    log("metadata fetch failed: " + err)
                    return {}
                })
        }

        function pickTitle(meta) {
            if (!meta || !meta.title) return ""
            if (typeof meta.title === "string") return meta.title
            return meta.title.en || meta.title["x-jat"] || meta.title.ja || ""
        }

        function pickRuntime(meta) {
            var rt = meta && (meta.runtime || meta.length)
            if (!rt) return ""
            return typeof rt === "number" ? rt + "m" : String(rt)
        }

        // How far should the extra cards go?
        function computeMax(ep, total, info, episodes) {
            var max = total
            if (info.releasing && info.nextAiring) {
                var aired = info.nextAiring - 1
                max = max ? Math.min(max, aired) : aired
            }
            if (!max) {
                Object.keys(episodes).forEach(function (k) {
                    var n = parseInt(k, 10)
                    if (!isNaN(n) && n > max) max = n
                })
            }
            if (!max) max = ep + 3
            return Math.min(max, ep + MAX_EXTRA)
        }

        // ---------- Playing an episode ----------
        function describeEntry(entry) {
            if (!entry) return "entry: none"
            var eps = entry.episodes || []
            var withFile = []
            for (var i = 0; i < eps.length; i++) {
                if (eps[i] && eps[i].localFile) withFile.push(eps[i].episodeNumber)
            }
            return "keys=" + Object.keys(entry).join(",") +
                " | episodes=" + eps.length + " | withFile=[" + withFile.join(",") + "]" +
                " | localFiles=" + ((entry.localFiles || []).length)
        }

        function findLocalPath(entry, n) {
            if (!entry) return ""
            var eps = entry.episodes || []
            for (var i = 0; i < eps.length; i++) {
                var e = eps[i]
                if (e && Number(e.episodeNumber) === n && e.localFile && e.localFile.path) return e.localFile.path
            }
            var files = entry.localFiles || []
            for (var j = 0; j < files.length; j++) {
                var f = files[j]
                if (f && f.path && f.metadata && Number(f.metadata.episode) === n) return f.path
            }
            // fallback: read the episode number from the file name
            for (var k = 0; k < files.length; k++) {
                var g = files[k]
                if (!g || !g.path) continue
                try {
                    var name = String(g.path).split(/[\\/]/).pop()
                    var parsed = $habari.parse(name)
                    var list = parsed && parsed.episode_number
                    if (list && list.length && Number(list[0]) === n) return g.path
                } catch (err) {}
            }
            return ""
        }

        function openEpisode(mediaId, n) {
            var id = Number(mediaId)
            function fallback() { ctx.screen.navigateTo("/entry", { id: String(id) }) }
            Promise.resolve().then(function () {
                return ctx.anime.getAnimeEntry(id)
            }).then(function (entry) {
                var path = findLocalPath(entry, n)
                if (!path) {
                    log("no local file for episode " + n + " -> " + describeEntry(entry))
                    ctx.toast.info("Episode " + n + " isn't in your library yet")
                    return fallback()
                }
                ctx.playback.playUsingMediaPlayer(path)
                ctx.toast.info("Playing episode " + n)
            }).catch(function (err) {
                log("could not play episode " + n + ": " + err)
                fallback()
            })
        }

        // ---------- DOM helpers ----------
        function mk(tag, attrs, styles) {
            return ctx.dom.createElement(tag).then(function (e) {
                Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]) })
                Object.keys(styles || {}).forEach(function (k) { e.setStyle(k, styles[k]) })
                return e
            })
        }

        function buildSlide(mediaId, ep, baseEp, total, info, meta) {
            var image = (meta && meta.image) || info.image || ""
            var epTitle = pickTitle(meta)
            var runtime = pickRuntime(meta)

            return Promise.all([
                mk("div", {
                    role: "group",
                    "data-up-next-for": String(mediaId),
                    "data-up-next-base": String(baseEp),
                    "class": "UI-Carousel__item min-w-0 shrink-0 grow-0 basis-full pl-4 md:basis-1/2 lg:basis-1/2 2xl:basis-1/3 min-[2000px]:basis-1/4"
                }),                                                                                              // 0 slide
                mk("div", { "class": "rounded-xl space-y-2 flex-none group/episode-card cursor-pointer select-none w-full" }), // 1 card
                mk("div", { "class": "w-full h-full rounded-xl overflow-hidden z-[1] aspect-[4/2] relative bg-[--background]" }), // 2 image box
                mk("img", {
                    alt: "", decoding: "async", loading: "lazy", src: image,
                    "class": "object-cover rounded-xl object-center transition-[opacity,transform] ease-out duration-400 opacity-100 scale-100 lg:group-hover/episode-card:scale-[1.02]"
                }, { position: "absolute", height: "100%", width: "100%", inset: "0px", color: "transparent" }),   // 3 img
                mk("div", { "class": "z-[1] absolute inset-x-0 bottom-0 w-full h-full opacity-90 md:h-[80%] bg-gradient-to-t from-[#0c0c0c] to-transparent rounded-b-xl" }), // 4 gradient
                mk("div", { "class": "absolute bottom-0 left-0 w-full h-fit z-[3] p-3" }),                       // 5 info box
                mk("div", { "class": "relative z-[3] w-full space-y-0" }),                                        // 6 info container
                mk("p", { "class": "w-[80%] line-clamp-1 md:text-lg font-semibold text-sm max-w-[80%] text-white/60" }), // 7 title
                mk("div", { "class": "w-full justify-between flex flex-none items-center" }),                     // 8 content row
                mk("p", { "class": "line-clamp-1 flex items-center" }),                                           // 9 subtitle
                mk("span", { "class": "flex-none text-base md:text-xl font-medium" }),                            // 10 "Episode N"
                mk("span", { "class": "opacity-40" }),                                                            // 11 " / total"
                mk("span", { "class": "text-[--muted] text-base md:text-lg ml-2 font-normal line-clamp-1" }),     // 12 show title
                mk("p", { "class": "text-[--muted] flex-none ml-2 text-sm md:text-base line-clamp-2 text-right" }), // 13 runtime
                mk("div", { "class": "group-hover/episode-card:opacity-100 cursor-pointer opacity-0 transition-opacity bg-gray-950 bg-opacity-60 z-[2] absolute inset-0 items-center justify-center hidden md:flex" }), // 14 hover overlay
                mk("div", {}, {
                    width: "4rem", height: "4rem", "border-radius": "9999px", background: "rgba(229,231,235,0.55)",
                    display: "flex", "align-items": "center", "justify-content": "center"
                }),                                                                                               // 15 play circle
                mk("div", {}, {
                    width: "0", height: "0", "border-top": "14px solid transparent", "border-bottom": "14px solid transparent",
                    "border-left": "22px solid rgba(17,24,39,0.85)", "margin-left": "6px"
                })                                                                                                // 16 play triangle
            ]).then(function (e) {
                e[7].setText(epTitle || "Up next")
                e[10].setText("Episode " + ep)
                e[11].setText(total ? " / " + total : "")
                e[12].setText(info.title ? "- " + info.title : "")
                e[13].setText(runtime)

                e[10].append(e[11])
                e[9].append(e[10])
                e[9].append(e[12])
                e[8].append(e[9])
                e[8].append(e[13])
                e[6].append(e[7])
                e[6].append(e[8])
                e[5].append(e[6])
                e[15].append(e[16])
                e[14].append(e[15])
                e[2].append(e[3])
                e[2].append(e[4])
                e[2].append(e[5])
                e[2].append(e[14])
                e[1].append(e[2])
                e[0].append(e[1])

                e[0].addEventListener("click", function () { openEpisode(mediaId, ep) })
                return e[0]
            })
        }

        // ---------- Sync the home screen ----------
        var runId = 0            // every new run supersedes the previous one
        var running = false
        var runSig = ""
        var runStarted = 0
        var lastSig = ""

        function removeStale(activeIds) {
            return ctx.dom.query("[data-up-next-for]").then(function (slides) {
                return Promise.all(slides.map(function (s) {
                    return s.getAttribute("data-up-next-for").then(function (id) {
                        if (activeIds.indexOf(id) === -1) s.remove()
                    })
                }))
            })
        }

        function build(card, mediaId, ep, total, myRun) {
            var info = getMediaMap()[mediaId] || { title: "", image: "", releasing: false, nextAiring: 0 }
            return getEpisodes(mediaId).then(function (episodes) {
                if (myRun !== runId) return
                var max = computeMax(ep, total, info, episodes)
                if (max <= ep) return                        // nothing after this episode
                log("building episodes " + (ep + 1) + "-" + max + " for media " + mediaId)
                return card.getParent().then(function (span) {
                    return span.getParent()                  // card -> span -> carousel slide
                }).then(function (baseSlide) {
                    if (myRun !== runId) return
                    // let the row scroll sideways, without a visible scrollbar
                    baseSlide.getParent().then(function (inner) { return inner.getParent() }).then(function (content) {
                        content.setStyle("overflow-x", "auto")
                        content.setStyle("scrollbar-width", "none")
                        content.setStyle("-ms-overflow-style", "none")
                    }).catch(function () {})
                    var prev = baseSlide
                    var chain = Promise.resolve()
                    for (var n = ep + 1; n <= max; n++) {
                        (function (num) {
                            chain = chain.then(function () {
                                if (myRun !== runId) return
                                return buildSlide(mediaId, num, ep, total, info, episodes[String(num)]).then(function (s) {
                                    if (myRun !== runId) return   // superseded while building
                                    prev.after(s)
                                    prev = s
                                })
                            })
                        })(n)
                    }
                    return chain.then(function () {
                        // mark the build as complete (only the last card carries the marker)
                        if (myRun === runId && prev !== baseSlide) prev.setAttribute("data-up-next-complete", "1")
                    })
                })
            })
        }

        function processCard(card, attrs, myRun) {
            var mediaId = attrs["data-media-id"]
            var ep = parseInt(attrs["data-episode-number"], 10)
            var total = parseInt(attrs["data-progress-total"], 10) || 0
            if (!mediaId || isNaN(ep)) return Promise.resolve()
            var sel = '[data-up-next-for="' + mediaId + '"]'
            return ctx.dom.query(sel + '[data-up-next-base="' + ep + '"][data-up-next-complete="1"]').then(function (fresh) {
                if (myRun !== runId) return
                if (fresh.length > 0) return                 // complete and up to date
                return ctx.dom.query(sel).then(function (old) {
                    if (myRun !== runId) return
                    old.forEach(function (s) { s.remove() })  // progress changed or half-built -> rebuild
                    return build(card, mediaId, ep, total, myRun)
                })
            })
        }

        function startRun(cards, sig) {
            var myRun = ++runId
            running = true
            runSig = sig
            runStarted = Date.now()
            Promise.all(cards.map(function (c) { return c.getAttributes() })).then(function (allAttrs) {
                if (myRun !== runId) return
                var ids = allAttrs.map(function (a) { return a["data-media-id"] })
                return removeStale(ids).then(function () {
                    mediaMapCache = null
                    var chain = Promise.resolve()
                    cards.forEach(function (c, i) {
                        chain = chain.then(function () {
                            if (myRun !== runId) return
                            return processCard(c, allAttrs[i], myRun)
                        })
                    })
                    return chain
                })
            }).then(function () {
                if (myRun === runId) running = false
            }, function (err) {
                if (myRun === runId) running = false
                log("run " + myRun + " failed: " + err)
            })
        }

        function tick(reason) {
            ctx.dom.query(SELECTOR).then(function (cards) {
                var sig = cards.map(function (c) { return String(c.id) }).join(",")
                var stuck = running && (Date.now() - runStarted > STUCK_MS)
                if (running && sig === runSig && !stuck) return               // healthy build in progress
                if (!running && cards.length === 0 && lastSig === "") return  // nothing to do
                if (sig !== lastSig) log("home screen changed (" + reason + "), " + cards.length + " card(s)")
                if (stuck) log("previous run looked stuck, restarting")
                lastSig = sig
                startRun(cards, sig)
            }, function (err) { log("tick failed: " + err) })
        }

        ctx.dom.onReady(function () {
            ctx.dom.observe(SELECTOR, function () { tick("observe") })

            if (typeof ctx.setInterval === "function") {
                ctx.setInterval(function () { tick("poll") }, REFRESH_MS)
            } else {
                log("ctx.setInterval is not available, relying on observe and navigation only")
            }

            ctx.screen.onNavigate(function (e) {
                if (e && e.pathname === "/") {
                    tick("navigate")
                    if (typeof ctx.setTimeout === "function") {
                        [800, 2500, 6000].forEach(function (ms) {
                            ctx.setTimeout(function () { tick("navigate+" + ms) }, ms)
                        })
                    }
                }
            })

            tick("ready")
        })

        // ---------- Tray panel ----------
        var tray = ctx.newTray({
            tooltipText: "Up next",
            iconUrl: "https://seanime.rahim.app/logo_2.png",
            withContent: true
        })
        var rows = ctx.state([])

        function refresh() {
            try {
                var collection = $anilist.getAnimeCollection(false)
                var lists = (collection && collection.MediaListCollection && collection.MediaListCollection.lists) || []
                var out = []
                lists.forEach(function (list) {
                    if (!list || String(list.status) !== "CURRENT") return
                    ;(list.entries || []).forEach(function (entry) {
                        var media = entry && entry.media
                        if (!media) return
                        var progress = Number(entry.progress) || 0
                        var total = Number(media.episodes) || 0
                        var title = (media.title && media.title.userPreferred && String(media.title.userPreferred)) || "Unknown"
                        for (var i = 1; i <= 3; i++) {
                            var ep = progress + i
                            if (total && ep > total) break
                            out.push({ mediaId: Number(media.id), title: title, ep: ep, total: total })
                        }
                    })
                })
                rows.set(out)
            } catch (err) {
                rows.set([])
            }
        }

        tray.onOpen(function () { refresh() })
        tray.render(function () {
            var current = rows.get()
            if (current.length === 0) return tray.stack([tray.text("Nothing found in Currently Watching.")])
            return tray.stack(current.map(function (r) {
                return tray.flex([
                    tray.text(r.title + " - Episode " + r.ep + (r.total ? " / " + r.total : "")),
                    tray.button({
                        label: "Play",
                        onClick: ctx.eventHandler("open-" + r.mediaId + "-" + r.ep, function () {
                            openEpisode(r.mediaId, r.ep)
                        })
                    })
                ])
            }))
        })
    })
}
