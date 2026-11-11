/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register(function (ctx) {
        var EXTRA_EPISODES = 2   // how many upcoming episodes to add after the existing card
        var building = false
        var episodeCache = {}

        // ---------- AniList lookup (show title + banner fallback) ----------
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
                        image: m.bannerImage || (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || ""
                    }
                })
            })
            return map
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
                    console.log("up-next: metadata fetch failed: " + err)
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

        // ---------- DOM helpers ----------
        function mk(tag, attrs, styles) {
            return ctx.dom.createElement(tag).then(function (e) {
                Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]) })
                Object.keys(styles || {}).forEach(function (k) { e.setStyle(k, styles[k]) })
                return e
            })
        }

        function buildSlide(mediaId, ep, total, info, meta) {
            var image = (meta && meta.image) || info.image || ""
            var epTitle = pickTitle(meta)
            var runtime = pickRuntime(meta)

            return Promise.all([
                mk("div", {
                    role: "group",
                    "data-up-next-for": String(mediaId),
                    "class": "UI-Carousel__item min-w-0 shrink-0 grow-0 basis-full pl-4 md:basis-1/2 lg:basis-1/2 2xl:basis-1/3 min-[2000px]:basis-1/4"
                }),                                                                                             // 0 slide
                mk("div", { "class": "rounded-xl space-y-2 flex-none cursor-pointer select-none w-full" }),     // 1 card
                mk("div", { "class": "w-full h-full rounded-xl overflow-hidden z-[1] aspect-[4/2] relative bg-[--background]" }), // 2 image box
                mk("img", {
                    alt: "", decoding: "async", loading: "lazy", src: image,
                    "class": "object-cover rounded-xl object-center"
                }, { position: "absolute", height: "100%", width: "100%", inset: "0px", color: "transparent" }),  // 3 img
                mk("div", { "class": "z-[1] absolute inset-x-0 bottom-0 w-full h-full opacity-90 md:h-[80%] bg-gradient-to-t from-[#0c0c0c] to-transparent rounded-b-xl" }), // 4 gradient
                mk("div", { "class": "absolute bottom-0 left-0 w-full h-fit z-[3] p-3" }),                      // 5 info box
                mk("div", { "class": "relative z-[3] w-full space-y-0" }),                                       // 6 info container
                mk("p", { "class": "w-[80%] line-clamp-1 md:text-lg font-semibold text-sm max-w-[80%] text-white/60" }), // 7 title
                mk("div", { "class": "w-full justify-between flex flex-none items-center" }),                    // 8 content row
                mk("p", { "class": "line-clamp-1 flex items-center" }),                                          // 9 subtitle
                mk("span", { "class": "flex-none text-base md:text-xl font-medium" }),                           // 10 "Episode N"
                mk("span", { "class": "opacity-40" }),                                                           // 11 " / total"
                mk("span", { "class": "text-[--muted] text-base md:text-lg ml-2 font-normal line-clamp-1" }),    // 12 show title
                mk("p", { "class": "text-[--muted] flex-none ml-2 text-sm md:text-base line-clamp-2 text-right" }) // 13 runtime
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
                e[2].append(e[3])
                e[2].append(e[4])
                e[2].append(e[5])
                e[1].append(e[2])
                e[0].append(e[1])

                e[0].addEventListener("click", function () {
                    ctx.screen.navigateTo("/entry", { id: String(mediaId) })
                })
                return e[0]
            })
        }

        function processCard(card, mediaMap) {
            return card.getAttributes().then(function (attrs) {
                var mediaId = attrs["data-media-id"]
                var ep = parseInt(attrs["data-episode-number"], 10)
                var total = parseInt(attrs["data-progress-total"], 10) || 0
                if (!mediaId || isNaN(ep)) return
                var info = mediaMap[mediaId] || { title: "", image: "" }

                return getEpisodes(mediaId).then(function (episodes) {
                    return card.getParent().then(function (span) {
                        return span.getParent()          // card -> span -> carousel slide
                    }).then(function (baseSlide) {
                        var prev = baseSlide
                        var chain = Promise.resolve()
                        for (var i = 1; i <= EXTRA_EPISODES; i++) {
                            (function (n) {
                                if (total && n > total) return
                                chain = chain.then(function () {
                                    return buildSlide(mediaId, n, total, info, episodes[String(n)]).then(function (s) {
                                        prev.after(s)
                                        prev = s
                                    })
                                })
                            })(ep + i)
                        }
                        return chain
                    })
                })
            })
        }

        // ---------- Home screen: add the extra cards ----------
        ctx.dom.onReady(function () {
            ctx.dom.observe("[data-continue-watching-container] [data-episode-card]", function (cards) {
                if (building || !cards || cards.length === 0) return
                building = true
                ctx.dom.query("[data-up-next-for]").then(function (existing) {
                    if (existing.length > 0) return          // already added on this render
                    var mediaMap = loadMediaMap()
                    var chain = Promise.resolve()
                    cards.forEach(function (c) {
                        chain = chain.then(function () { return processCard(c, mediaMap) })
                    })
                    return chain
                }).then(function () {
                    building = false
                }, function (err) {
                    building = false
                    console.log("up-next error: " + err)
                })
            })
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
                        label: "Open",
                        onClick: ctx.eventHandler("open-" + r.mediaId + "-" + r.ep, function () {
                            ctx.screen.navigateTo("/entry", { id: String(r.mediaId) })
                        })
                    })
                ])
            }))
        })
    })
}
