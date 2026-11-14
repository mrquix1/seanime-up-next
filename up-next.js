        // ---------- Sync the home screen ----------
        var DEBUG = true
        var runId = 0            // every new run supersedes the previous one
        var running = false
        var runSig = ""
        var runStarted = 0
        var lastSig = ""

        function log(msg) { if (DEBUG) console.log("up-next: " + msg) }

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
            log("run " + myRun + " started (" + cards.length + " card(s))")
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
                if (myRun === runId) { running = false; log("run " + myRun + " finished") }
            }, function (err) {
                if (myRun === runId) running = false
                log("run " + myRun + " failed: " + err)
            })
        }

        function tick(reason) {
            ctx.dom.query(SELECTOR).then(function (cards) {
                var sig = cards.map(function (c) { return String(c.id) }).join(",")
                var stuck = running && (Date.now() - runStarted > STUCK_MS)
                if (running && sig === runSig && !stuck) return        // healthy build in progress
                if (!running && cards.length === 0 && lastSig === "") return   // nothing to do
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
                        var delays = [800, 2500, 6000]
                        delays.forEach(function (ms) {
                            ctx.setTimeout(function () { tick("navigate+" + ms) }, ms)
                        })
                    }
                }
            })

            tick("ready")
        })
