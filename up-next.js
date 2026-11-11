/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register(function (ctx) {
        var EXTRA_EPISODES = 2   // how many upcoming episodes to add after the existing card
        var building = false

        // ---------- AniList lookup (title + image per show) ----------
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

        // ---------- DOM helpers ----------
        function mk(tag, attrs, styles) {
            return ctx.dom.createElement(tag).then(function (e) {
                Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]) })
                Object.keys(styles || {}).forEach(function (k) { e.setStyle(k, styles[k]) })
                return e
            })
        }

        function buildSlide(mediaId, ep, total, info) {
            var bg = info.image ? { "background-image": "url(" + info.image + ")", "background-size": "cover", "background-position": "center" } : {}
            return Promise.all([
                mk("div", {
                    role: "group",
                    "data-up-next-for": String(mediaId),
                    "class": "UI-Carousel__item min-w-0 shrink-0 grow-0 basis-full pl-4 md:basis-1/2 lg:basis-1/2 2xl:basis-1/3 min-[2000px]:basis-1/4"
                }),
                mk("div", { "class": "rounded-xl space-y-2 flex-none cursor-pointer select-none w-full" }),
                mk("div", { "class": "w-full h-full rounded-xl overflow-hidden aspect-[4/2] relative bg-[--background]" }, bg),
                mk("div", { "class": "absolute inset-x-0 bottom-0 w-full h-full opacity-90 md:h-[80%] bg-gradient-to-t from-[#0c0c0c] to-transparent rounded-b-xl" }),
                mk("div", { "class": "absolute bottom-0 left-0 w-full h-fit z-[3] p-3" }),
                mk("p", { "class": "w-[80%] line-clamp-1 md:text-lg font-semibold text-sm text-white/60" }),
                mk("p", { "class": "line-clamp-1 text-base md:text-xl font-medium" })
            ]).then(function (els) {
                var slide = els[0], card = els[1], box = els[2], grad = els[3], infoBox = els[4], l1 = els[5], l2 = els[6]
                l1.setText("Up next")
                l2.setText("Episode " + ep + (total ? " / " + total : "") + (info.title ? " - " + info.title : ""))
                infoBox.append(l1)
                infoBox.append(l2)
                box.append(grad)
                box.append(infoBox)
                card.append(box)
                slide.append(card)
                slide.addEventListener("click", function () {
                    ctx.screen.navigateTo("/entry", { id: String(mediaId) })
                })
                return slide
            })
        }

        function processCard(card, mediaMap) {
            return card.getAttributes().then(function (attrs) {
                var mediaId = attrs["data-media-id"]
                var ep = parseInt(attrs["data-episode-number"], 10)
                var total = parseInt(attrs["data-progress-total"], 10) || 0
                if (!mediaId || isNaN(ep)) return
                var info = mediaMap[mediaId] || { title: "", image: "" }

                return card.getParent().then(function (span) {
                    return span.getParent()          // card -> span -> carousel slide
                }).then(function (baseSlide) {
                    var prev = baseSlide
                    var chain = Promise.resolve()
                    for (var i = 1; i <= EXTRA_EPISODES; i++) {
                        (function (n) {
                            if (total && n > total) return
                            chain = chain.then(function () {
                                return buildSlide(mediaId, n, total, info).then(function (s) {
                                    prev.after(s)
                                    prev = s
                                })
                            })
                        })(ep + i)
                    }
                    return chain
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

        // ---------- Tray panel (unchanged, debug line removed) ----------
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
