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

        // ---------- Hero banner settings ----------
        var HERO_COUNT = 8            // how many anime the hero rotates through
        var HERO_ROTATE_MS = 9000     // auto-advance time
        var HERO_ANCHOR = "[data-home-toolbar-container]"   // the hero is inserted right after this element
        var heroData = null
        var heroLoading = false
        var heroRetryAt = 0
        var heroBuilding = false
        var heroIndex = 0
        var heroPausedUntil = 0
        var heroBusy = false          // a hero check is in progress (prevents two checks from both building a hero)
        var heroCooldownUntil = 0     // short pause after a build so the new hero is in the DOM before the next check
        var hero = null
        var addedIds = {}             // anime added to the list through the hero "+" button

        // ---------- Latest Episodes row settings ----------
        var LATEST_COUNT = 14             // cards in the row
        var LATEST_DAYS = 7               // how far back to look for aired episodes
        var LATEST_REFRESH_MS = 900000    // reload the data every 15 minutes
        var LATEST_ONLY_MY_LIST = false   // true = only show anime that are on your AniList
        var latestData = null
        var latestLoading = false
        var latestLoadedAt = 0
        var latestRetryAt = 0
        var latestVersion = 0
        var latestBusy = false
        var latestCooldownUntil = 0

        // ---------- Watch progress (badges + red line) ----------
        var STORAGE_KEY = "up-next.progress"
        var progressMap = {}          // "mediaId:episode" -> { t: seconds watched, d: duration }
        var progressDirty = false
        var progressTracked = {}
        var progressErrLogged = false
        var progBusy = false
        var pathCache = {}            // normalized file path -> { mediaId, ep }
        var pathMissAt = {}           // normalized file path -> time of the last failed lookup
        var pathResolving = {}

        function log(msg) { if (DEBUG) console.log("up-next: " + msg) }

        function show(x) {
            try { var t = JSON.stringify(x); return t === undefined ? String(x) : t.slice(0, 500) } catch (e) { return String(x) }
        }

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
                        nextAiring: (m.nextAiringEpisode && Number(m.nextAiringEpisode.episode)) || 0,
                        progress: Number(entry.progress) || 0
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

        function normPath(p) {
            return String(p || "").replace(/\\/g, "/").toLowerCase()
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
                pathCache[normPath(path)] = { mediaId: id, ep: n }   // lets watch progress know what is playing
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

        // ---------- Hero banner ----------
        function stripHtml(s) {
            return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
        }

        function isInList(id) {
            if (addedIds[id]) return true
            try { return !!getMediaMap()[String(id)] } catch (e) { return false }
        }

        function loadHeroData() {
            if (heroData || heroLoading || Date.now() < heroRetryAt) return Promise.resolve()
            heroLoading = true
            var query = "query { Page(page: 1, perPage: 20) { media(type: ANIME, sort: TRENDING_DESC, isAdult: false) { id title { userPreferred } genres averageScore description(asHtml: false) bannerImage coverImage { extraLarge large } episodes duration } } }"
            return fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ query: query })
            }).then(function (res) {
                return Promise.resolve(res.json())
            }).then(function (data) {
                var list = (data && data.data && data.data.Page && data.data.Page.media) || []
                var withBanner = list.filter(function (m) { return m && m.bannerImage })
                heroLoading = false
                if (!withBanner.length) { heroRetryAt = Date.now() + 60000; return }
                heroData = withBanner.slice(0, HERO_COUNT)
                log("hero: loaded " + heroData.length + " anime")
            }, function (err) {
                heroLoading = false
                heroRetryAt = Date.now() + 60000
                log("hero: load failed: " + err)
            })
        }

        function showHero(i) {
            if (!hero || !heroData || !heroData.length) return
            heroIndex = (i + heroData.length) % heroData.length
            var m = heroData[heroIndex]
            var score = m.averageScore ? (m.averageScore / 10).toFixed(1) : ""
            hero.bg.setStyle("background-image", 'url("' + m.bannerImage + '")')
            hero.cover.setAttribute("src", (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || "")
            hero.title.setText((m.title && m.title.userPreferred) || "")
            hero.genres.setText((m.genres || []).slice(0, 3).join(" • "))
            hero.score.setText(score ? "★ " + score : "")
            hero.desc.setText(stripHtml(m.description))
            hero.dots.forEach(function (d, n) { d.setAttribute("data-active", n === heroIndex ? "true" : "false") })
            hero.mediaId = m.id

            // "+" button: shows a check when the anime is already on your list
            var inList = isInList(m.id)
            hero.plus.setText(inList ? "✓" : "+")
            hero.plus.setAttribute("data-added", inList ? "true" : "false")
            hero.plus.setAttribute("title", inList ? "On your list" : "Add to your list (Planning)")

            // episode card on the right: "Episode N / total" + runtime
            var mine = null
            try { mine = getMediaMap()[String(m.id)] } catch (e) {}
            var nextEp = mine ? mine.progress + 1 : 1
            if (m.episodes && nextEp > m.episodes) nextEp = m.episodes
            hero.epNumber = nextEp
            hero.epLabel.setText("Episode " + nextEp + (m.episodes ? " / " + m.episodes : ""))
            hero.epRuntime.setText(m.duration ? m.duration + "m" : "")
            hero.epImg.setAttribute("src", m.bannerImage || "")
        }

        function heroAdd() {
            if (!hero || !hero.mediaId) return
            var id = Number(hero.mediaId)
            if (isInList(id)) { ctx.toast.info("Already on your list"); return }
            Promise.resolve().then(function () {
                $anilist.updateEntry(id, "PLANNING", 0, 0, undefined, undefined)
            }).then(function () {
                addedIds[id] = true
                mediaMapCache = null
                try { $anilist.refreshAnimeCollection() } catch (e) {}
                ctx.toast.success("Added to your list (Planning)")
                log("hero: added " + id + " to PLANNING")
                if (hero) showHero(heroIndex)
            }).catch(function (err) {
                log("hero: add to list failed: " + err)
                ctx.toast.error("Couldn't add to your list: " + err)
            })
        }

        function buildHero(anchor) {
            heroBuilding = true
            var dots = []
            for (var i = 0; i < heroData.length; i++) dots.push(mk("span", { "class": "mq-hero-dot", "data-active": "false" }))
            return Promise.all([
                mk("div", { "class": "mq-hero", "data-mq-hero": "1" }),   // 0 root
                mk("div", { "class": "mq-hero-bg" }),                     // 1 background image
                mk("div", { "class": "mq-hero-fade" }),                   // 2 gradients
                mk("div", { "class": "mq-hero-content" }),                // 3 content row
                mk("img", { "class": "mq-hero-cover", alt: "" }),         // 4 cover
                mk("div", { "class": "mq-hero-text" }),                   // 5 text column
                mk("h1", { "class": "mq-hero-title" }),                   // 6 title
                mk("div", { "class": "mq-hero-meta" }),                   // 7 meta row
                mk("span", {}),                                           // 8 genres
                mk("span", {}),                                           // 9 score
                mk("p", { "class": "mq-hero-desc" }),                     // 10 synopsis
                mk("div", { "class": "mq-hero-buttons" }),                // 11 buttons row
                mk("button", { "class": "mq-hero-btn" }),                 // 12 info
                mk("div", { "class": "mq-hero-nav" }),                    // 13 arrows box
                mk("button", { "class": "mq-hero-arrow" }),               // 14 prev
                mk("button", { "class": "mq-hero-arrow" }),               // 15 next
                mk("div", { "class": "mq-hero-dots" }),                   // 16 dots box
                Promise.all(dots),                                        // 17 dots
                mk("button", { "class": "mq-hero-btn mq-hero-plus", "data-added": "false", title: "Add to your list" }), // 18 + button
                mk("div", { "class": "mq-hero-ep" }),                     // 19 episode card
                mk("img", { "class": "mq-hero-ep-img", alt: "" }),        // 20 episode thumbnail
                mk("div", { "class": "mq-hero-ep-shade" }),               // 21 dark gradient
                mk("div", { "class": "mq-hero-ep-play" }),                // 22 play triangle
                mk("span", { "class": "mq-hero-ep-label" }),              // 23 "Episode N / T"
                mk("span", { "class": "mq-hero-ep-runtime" })             // 24 "24m"
            ]).then(function (e) {
                e[12].setText("ⓘ  Info")
                e[14].setText("←")
                e[15].setText("→")
                e[18].setText("+")

                e[7].append(e[8]); e[7].append(e[9])
                e[17].forEach(function (d) { e[16].append(d) })
                e[11].append(e[12]); e[11].append(e[18]); e[11].append(e[16])
                e[5].append(e[6]); e[5].append(e[7]); e[5].append(e[10]); e[5].append(e[11])
                e[3].append(e[4]); e[3].append(e[5])
                e[13].append(e[14]); e[13].append(e[15])
                e[19].append(e[20]); e[19].append(e[21]); e[19].append(e[22]); e[19].append(e[23]); e[19].append(e[24])
                e[0].append(e[1]); e[0].append(e[2]); e[0].append(e[3]); e[0].append(e[13]); e[0].append(e[19])

                e[12].addEventListener("click", function () {
                    if (hero && hero.mediaId) ctx.screen.navigateTo("/entry", { id: String(hero.mediaId) })
                })
                e[18].addEventListener("click", function () { heroAdd() })
                e[14].addEventListener("click", function () { heroPausedUntil = Date.now() + 20000; showHero(heroIndex - 1) })
                e[15].addEventListener("click", function () { heroPausedUntil = Date.now() + 20000; showHero(heroIndex + 1) })
                e[17].forEach(function (d, k) {
                    d.addEventListener("click", function () { heroPausedUntil = Date.now() + 20000; showHero(k) })
                })
                // episode card: play the next episode if the show is on your list, otherwise open its page
                e[19].addEventListener("click", function () {
                    if (!hero || !hero.mediaId) return
                    if (isInList(hero.mediaId)) openEpisode(hero.mediaId, hero.epNumber || 1)
                    else ctx.screen.navigateTo("/entry", { id: String(hero.mediaId) })
                })

                hero = {
                    root: e[0], bg: e[1], cover: e[4], title: e[6], genres: e[8], score: e[9], desc: e[10], dots: e[17],
                    plus: e[18], epImg: e[20], epLabel: e[23], epRuntime: e[24], epNumber: 1, mediaId: 0
                }
                showHero(heroIndex)
                anchor.after(e[0])
            }).then(function () {
                heroBuilding = false
            }, function (err) {
                heroBuilding = false
                log("hero build failed: " + err)
            })
        }

        function removeAllHeroes() {
            return ctx.dom.query("[data-mq-hero]").then(function (list) {
                list.forEach(function (el) { el.remove() })
            })
        }

        function heroTick() {
            if (heroBusy || heroBuilding || Date.now() < heroCooldownUntil) return
            if (!heroData) {
                loadHeroData().then(function () { if (heroData) heroTick() })
                return
            }
            heroBusy = true
            ctx.dom.query(HERO_ANCHOR).then(function (anchors) {
                if (!anchors.length) {
                    hero = null
                    return removeAllHeroes()                          // left the home screen: clean up
                }
                return ctx.dom.query("[data-mq-hero]").then(function (found) {
                    if (found.length === 1) return                    // exactly one hero: all good
                    if (found.length > 1) log("hero: found " + found.length + " heroes, rebuilding")
                    found.forEach(function (el) { el.remove() })      // none to clear, or duplicates to clear
                    hero = null
                    return buildHero(anchors[0]).then(function () {
                        heroCooldownUntil = Date.now() + 1500
                    })
                })
            }).then(function () {
                heroBusy = false
            }, function (err) {
                heroBusy = false
                log("hero tick failed: " + err)
            })
        }

        // ---------- Latest Episodes row ----------
        function timeAgo(ts) {
            var s = Math.max(0, Math.floor(Date.now() / 1000) - Number(ts))
            if (s < 3600) return Math.max(1, Math.floor(s / 60)) + "m ago"
            if (s < 86400) return Math.floor(s / 3600) + "h ago"
            return Math.floor(s / 86400) + "d ago"
        }

        function loadLatestData() {
            var fresh = latestData && (Date.now() - latestLoadedAt < LATEST_REFRESH_MS)
            if (latestLoading || fresh || Date.now() < latestRetryAt) return Promise.resolve()
            latestLoading = true
            var now = Math.floor(Date.now() / 1000)
            var query = "query { Page(page: 1, perPage: 50) { airingSchedules(airingAt_lesser: " + now +
                ", airingAt_greater: " + (now - LATEST_DAYS * 86400) + ", sort: TIME_DESC) { episode airingAt media { id isAdult countryOfOrigin title { userPreferred } bannerImage coverImage { extraLarge large } } } } }"
            return fetch("https://graphql.anilist.co", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json" },
                body: JSON.stringify({ query: query })
            }).then(function (res) {
                return Promise.resolve(res.json())
            }).then(function (data) {
                latestLoading = false
                var items = (data && data.data && data.data.Page && data.data.Page.airingSchedules) || []
                var map = {}
                try { map = getMediaMap() } catch (e) {}
                var seen = {}
                var mine = []
                var rest = []
                items.forEach(function (s) {
                    var m = s && s.media
                    if (!m || m.isAdult || (m.countryOfOrigin && m.countryOfOrigin !== "JP")) return
                    if (seen[m.id]) return
                    seen[m.id] = true
                    var image = m.bannerImage || (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || ""
                    if (!image) return
                    var item = {
                        id: m.id, title: (m.title && m.title.userPreferred) || "", ep: s.episode, at: s.airingAt, image: image
                    }
                    if (map[String(m.id)]) mine.push(item); else rest.push(item)
                })
                var out = LATEST_ONLY_MY_LIST ? mine : mine.concat(rest)
                if (!out.length) { latestRetryAt = Date.now() + 60000; return }
                latestData = out.slice(0, LATEST_COUNT)
                latestLoadedAt = Date.now()
                latestVersion++
                log("latest: loaded " + latestData.length + " episodes")
            }, function (err) {
                latestLoading = false
                latestRetryAt = Date.now() + 60000
                log("latest: load failed: " + err)
            })
        }

        function buildLatestCard(it) {
            return Promise.all([
                mk("div", { "class": "mq-latest-card" }),                                          // 0 card
                mk("div", { "class": "mq-latest-thumb" }),                                         // 1 thumbnail box
                mk("img", { "class": "mq-latest-img", alt: "", loading: "lazy", src: it.image }),  // 2 image
                mk("span", { "class": "mq-latest-badge" }),                                        // 3 episode badge
                mk("p", { "class": "mq-latest-name" }),                                            // 4 title
                mk("p", { "class": "mq-latest-sub" })                                              // 5 subtitle
            ]).then(function (e) {
                e[3].setText("Episode " + it.ep)
                e[4].setText(it.title)
                e[5].setText(timeAgo(it.at))
                e[1].append(e[2]); e[1].append(e[3])
                e[0].append(e[1]); e[0].append(e[4]); e[0].append(e[5])
                e[0].addEventListener("click", function () { ctx.screen.navigateTo("/entry", { id: String(it.id) }) })
                return e[0]
            })
        }

        function buildLatest(anchor, kind) {
            return Promise.all([
                mk("div", {
                    "class": "mq-latest", "data-mq-latest": "1",
                    "data-mq-latest-v": String(latestVersion), "data-mq-latest-anchor": kind
                }),                                                       // 0 root
                mk("h2", { "class": "mq-latest-title" }),                 // 1 heading
                mk("div", { "class": "mq-latest-row" }),                  // 2 scrolling row
                Promise.all(latestData.map(buildLatestCard)),             // 3 cards
                mk("div", { "class": "mq-latest-head" }),                 // 4 heading row
                mk("span", { "class": "mq-latest-more" })                 // 5 "View more"
            ]).then(function (e) {
                e[1].setText("Latest Episodes")
                e[5].setText("View more ›")
                e[5].addEventListener("click", function () { ctx.screen.navigateTo("/schedule") })
                e[3].forEach(function (c) { e[2].append(c) })
                e[4].append(e[1]); e[4].append(e[5])
                e[0].append(e[4]); e[0].append(e[2])
                anchor.after(e[0])
            })
        }

        function removeAll(list) {
            list.forEach(function (el) { el.remove() })
        }

        function latestTick() {
            if (latestBusy || Date.now() < latestCooldownUntil) return
            var stale = !latestData || (Date.now() - latestLoadedAt >= LATEST_REFRESH_MS)
            if (stale && !latestLoading && Date.now() >= latestRetryAt) {
                loadLatestData().then(function () { if (latestData) latestTick() })   // runs again once the data is in
            }
            if (!latestData) return
            latestBusy = true
            Promise.all([
                ctx.dom.query(HERO_ANCHOR),
                ctx.dom.query("[data-continue-watching-container]"),
                ctx.dom.query("[data-mq-hero]"),
                ctx.dom.query("[data-mq-latest]")
            ]).then(function (r) {
                var toolbar = r[0], cw = r[1], heroEl = r[2], found = r[3]
                if (!toolbar.length) return removeAll(found)              // left the home screen
                var anchor = cw.length ? cw[0] : (heroEl.length ? heroEl[0] : null)
                var kind = cw.length ? "cw" : "hero"
                if (!anchor) return removeAll(found)
                function rebuild() {
                    removeAll(found)
                    return buildLatest(anchor, kind).then(function () { latestCooldownUntil = Date.now() + 1500 })
                }
                if (found.length === 1) {
                    return found[0].getAttributes().then(function (a) {
                        if (a["data-mq-latest-v"] === String(latestVersion) && a["data-mq-latest-anchor"] === kind) return
                        return rebuild()
                    })
                }
                return rebuild()
            }).then(function () {
                latestBusy = false
            }, function (err) {
                latestBusy = false
                log("latest tick failed: " + err)
            })
        }

        // ---------- Watch progress ----------
        function loadProgress() {
            try {
                if (typeof $storage === "undefined") return
                var raw = $storage.get(STORAGE_KEY)
                if (!raw) return
                var obj = typeof raw === "string" ? JSON.parse(raw) : raw
                if (obj && typeof obj === "object") progressMap = obj
                log("progress: loaded " + Object.keys(progressMap).length + " saved position(s)")
            } catch (err) { log("progress: could not load: " + err) }
        }

        function flushProgress() {
            if (!progressDirty) return
            progressDirty = false
            try {
                if (typeof $storage !== "undefined") $storage.set(STORAGE_KEY, progressMap)
            } catch (err) { log("progress: could not save: " + err) }
        }

        function fmtTime(sec) {
            sec = Math.max(0, Math.floor(Number(sec) || 0))
            var h = Math.floor(sec / 3600)
            var m = Math.floor((sec % 3600) / 60)
            var s = sec % 60
            function pad(n) { return n < 10 ? "0" + n : String(n) }
            return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s)
        }

        function unwrap(val) {
            if (val && typeof val === "object" && val.data !== undefined) return val.data
            return val
        }

        // Which shows could this file belong to? The ones you're currently watching.
        function watchingCandidates() {
            var out = []
            try {
                var collection = $anilist.getAnimeCollection(false)
                var lists = (collection && collection.MediaListCollection && collection.MediaListCollection.lists) || []
                lists.forEach(function (list) {
                    var st = list && String(list.status)
                    if (st !== "CURRENT" && st !== "REPEATING") return
                    ;(list.entries || []).forEach(function (entry) {
                        if (entry && entry.media) out.push({ mediaId: Number(entry.media.id), progress: Number(entry.progress) || 0 })
                    })
                })
            } catch (err) {}
            return out
        }

        function resolvePath(path) {
            var np = normPath(path)
            if (pathCache[np]) return Promise.resolve(pathCache[np])
            if (pathMissAt[np] && Date.now() - pathMissAt[np] < 30000) return Promise.resolve(null)
            if (pathResolving[np]) return pathResolving[np]
            var candidates = watchingCandidates()
            var found = null
            var chain = Promise.resolve()
            candidates.forEach(function (c) {
                chain = chain.then(function () {
                    if (found) return
                    return Promise.resolve(ctx.anime.getAnimeEntry(c.mediaId)).then(function (entry) {
                        for (var n = Math.max(1, c.progress); n <= c.progress + 4; n++) {
                            var p = findLocalPath(entry, n)
                            if (p && normPath(p) === np) { found = { mediaId: c.mediaId, ep: n }; return }
                        }
                    }, function () {})
                })
            })
            var p = chain.then(function () {
                delete pathResolving[np]
                if (found) { pathCache[np] = found; log("progress: now playing media " + found.mediaId + " ep " + found.ep) }
                else pathMissAt[np] = Date.now()
                return found
            })
            pathResolving[np] = p
            return p
        }

        function pollProgress() {
            var conn
            try { conn = ctx.mpv.getConnection() } catch (e) { conn = null }
            if (!conn || conn.isClosed()) return
            function get(prop) {
                return Promise.resolve().then(function () { return conn.get(prop) }).then(unwrap)
            }
            Promise.all([get("path"), get("time-pos"), get("duration")]).then(function (v) {
                var path = v[0]
                var t = Number(v[1])
                var d = Number(v[2])
                if (!path || !isFinite(t) || !isFinite(d) || d <= 0 || t < 0) return
                return resolvePath(String(path)).then(function (info) {
                    if (!info) return
                    var key = info.mediaId + ":" + info.ep
                    if (t / d >= 0.92) {                     // finished: Seanime moves on, so drop the saved position
                        if (progressMap[key]) { delete progressMap[key]; progressDirty = true }
                        return
                    }
                    var prev = progressMap[key]
                    if (!prev || Math.abs(prev.t - t) >= 5 || prev.d !== Math.round(d)) {
                        progressMap[key] = { t: Math.floor(t), d: Math.round(d) }
                        progressDirty = true
                        if (!progressTracked[key]) { progressTracked[key] = true; log("progress: tracking " + key + " at " + fmtTime(t) + "/" + fmtTime(d)) }
                    }
                })
            }).catch(function (err) {
                if (!progressErrLogged) { progressErrLogged = true; log("progress poll failed: " + err) }
            })
        }

        function upsertProgress(mid, ep, key, pr, pct) {
            var label = fmtTime(pr.t) + "/" + fmtTime(pr.d)
            return ctx.dom.query('.mq-progress-fill[data-mq-key="' + key + '"]').then(function (fills) {
                if (fills.length) {
                    fills.forEach(function (f) { f.setStyle("width", pct + "%") })
                    return ctx.dom.query('.mq-time-badge[data-mq-key="' + key + '"]').then(function (badges) {
                        badges.forEach(function (b) { b.setText(label) })
                    })
                }
                var target = '[data-episode-card][data-media-id="' + mid + '"][data-episode-number="' + ep + '"] [class*="bottom-0 left-0 w-full"]'
                return ctx.dom.query(target).then(function (boxes) {
                    if (!boxes.length) return
                    return Promise.all([
                        mk("span", { "class": "mq-progress-track", "data-mq-key": key }),
                        mk("span", { "class": "mq-progress-fill", "data-mq-key": key }, { width: pct + "%" }),
                        mk("span", { "class": "mq-time-badge", "data-mq-key": key })
                    ]).then(function (e) {
                        e[2].setText(label)
                        e[0].append(e[1])
                        boxes[0].append(e[0])
                        boxes[0].append(e[2])
                    })
                })
            })
        }

        function applyProgress() {
            if (progBusy) return
            progBusy = true
            ctx.dom.query(SELECTOR).then(function (cards) {
                return Promise.all(cards.map(function (c) { return c.getAttributes() })).then(function (all) {
                    var active = {}
                    var work = Promise.resolve()
                    all.forEach(function (a) {
                        var mid = a["data-media-id"]
                        var ep = a["data-episode-number"]
                        if (!mid || !ep) return
                        var key = mid + ":" + ep
                        var pr = progressMap[key]
                        if (!pr || !pr.d) return
                        var pct = Math.max(0, Math.min(100, Math.round(pr.t / pr.d * 1000) / 10))
                        if (pct < 1) return
                        active[key] = true
                        work = work.then(function () { return upsertProgress(mid, ep, key, pr, pct) })
                    })
                    return work.then(function () {
                        // remove leftovers whose card no longer shows that episode
                        return ctx.dom.query("[data-mq-key]").then(function (els) {
                            return Promise.all(els.map(function (el) {
                                return el.getAttribute("data-mq-key").then(function (k) {
                                    if (!active[k]) el.remove()
                                })
                            }))
                        })
                    })
                })
            }).then(function () {
                progBusy = false
            }, function (err) {
                progBusy = false
                log("progress apply failed: " + err)
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
            heroTick()
            latestTick()
            applyProgress()
            tidySidebar()
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
                // hero auto-advance
                ctx.setInterval(function () {
                    if (!hero || !heroData || heroData.length < 2 || Date.now() < heroPausedUntil) return
                    try { showHero(heroIndex + 1) } catch (err) {}
                }, HERO_ROTATE_MS)

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

        // ---------- Player settings: learning mode ----------
        // Watches mpv (MpvCore) and logs changes to subtitles, audio and Anime4K, so we can see
        // exactly what changes. The next step turns this into "remember and re-apply".
        var MPV_PROPS = ["path", "sid", "secondary-sid", "sub-visibility", "aid", "glsl-shaders"]
        var mpvLast = {}
        var mpvFailed = {}
        var mpvConnected = false
        var mpvSeenEvents = {}

        function pollMpv() {
            var conn
            try { conn = ctx.mpv.getConnection() } catch (e) { conn = null }
            if (!conn || conn.isClosed()) {
                if (mpvConnected) { mpvConnected = false; mpvLast = {}; log("mpv connection gone") }
                return
            }
            if (!mpvConnected) { mpvConnected = true; log("mpv connection found") }
            MPV_PROPS.forEach(function (prop) {
                Promise.resolve().then(function () { return conn.get(prop) }).then(function (val) {
                    var s = show(val)
                    if (mpvLast[prop] !== s) {
                        log("mpv " + prop + " = " + s + (mpvLast[prop] === undefined ? "" : "   (was " + mpvLast[prop] + ")"))
                        mpvLast[prop] = s
                    }
                }, function (err) {
                    if (!mpvFailed[prop]) { mpvFailed[prop] = true; log("mpv get " + prop + " failed: " + err) }
                })
            })
        }

        function askVideoCore() {
            try {
                if (!ctx.videoCore.getCurrentClientId()) return
                ctx.videoCore.sendGetAnime4K()
                ctx.videoCore.sendGetSubtitleTrack()
                ctx.videoCore.sendGetAudioTrack()
            } catch (err) {}
        }

        function startPlayerWatch() {
            // log each distinct kind of mpv event once (the stream itself is very chatty)
            try {
                ctx.mpv.onEvent(function (event, closed) {
                    if (closed) { log("mpv event stream closed"); return }
                    var name = (event && (event.event || event.name)) || "unknown"
                    if (!mpvSeenEvents[name]) {
                        mpvSeenEvents[name] = true
                        log("mpv event type '" + name + "': " + show(event))
                    }
                })
            } catch (err) {
                log("mpv onEvent failed: " + err)
            }

            // in case the player also reports through VideoCore
            var VC_EVENTS = [
                "video-loaded", "video-can-play", "video-anime-4k",
                "video-subtitle-track", "video-audio-track", "video-media-caption-track"
            ]
            VC_EVENTS.forEach(function (name) {
                try {
                    ctx.videoCore.addEventListener(name, function (event) { log("videocore " + name + " -> " + show(event)) })
                } catch (err) {
                    log("cannot listen to " + name + ": " + err)
                }
            })

            if (typeof ctx.setInterval === "function") {
                ctx.setInterval(pollMpv, 2000)
                ctx.setInterval(askVideoCore, 4000)
                // watch progress: read the playback position, save it, and draw it on the cards
                ctx.setInterval(pollProgress, 3000)
                ctx.setInterval(function () { flushProgress(); applyProgress() }, 3000)
                ctx.setInterval(tidySidebar, 2000)
            }
        }

        // ---------- Sidebar: keep only a few buttons ----------
        // Links (by address) that stay in the sidebar. Everything else in the menu is hidden.
        // The first time it runs, the log shows every sidebar link ("up-next: sidebar: links = ..."),
        // so you can add or remove addresses here.
        var SIDEBAR_KEEP = ["/", "/schedule", "/lists", "/discover", "/torrent-list", "/settings"]
        var sidebarLogged = false
        var sidebarBusy = false

        function tidySidebar() {
            if (sidebarBusy) return
            sidebarBusy = true
            ctx.dom.query(".UI-AppSidebar__sidebar .UI-VerticalMenu__item").then(function (items) {
                return Promise.all(items.map(function (it) {
                    return Promise.resolve(it.getAttribute("href")).then(function (h) { return { it: it, href: String(h || "").split("?")[0].replace(/(.)\/$/, "$1") } })
                })).then(function (list) {
                    if (!sidebarLogged && list.length) {
                        sidebarLogged = true
                        log("sidebar: links = " + list.map(function (x) { return x.href || "(button)" }).join("  "))
                    }
                    list.forEach(function (x) {
                        if (!x.href || SIDEBAR_KEEP.indexOf(x.href) === -1) x.it.setStyle("display", "none")
                    })
                })
            }).then(function () { sidebarBusy = false }, function (err) { sidebarBusy = false; log("sidebar tidy failed: " + err) })
        }

        loadProgress()
        startPlayerWatch()

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
