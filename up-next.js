/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./core.d.ts" />

function init() {
    $ui.register(function (ctx) {
        var EPISODES_AHEAD = 3

        var tray = ctx.newTray({
            tooltipText: "Up next",
            iconUrl: "https://seanime.rahim.app/logo_2.png",
            withContent: true
        })

        var rows = ctx.state([])
        var debug = ctx.state("not loaded yet")

        function refresh() {
            try {
                var collection = $anilist.getAnimeCollection(false)
                var mlc = collection && collection.MediaListCollection
                var lists = (mlc && mlc.lists) || []
                var out = []
                var seen = []

                for (var l = 0; l < lists.length; l++) {
                    var list = lists[l]
                    if (!list) continue
                    var status = String(list.status)
                    var entries = list.entries || []
                    seen.push(status + " (" + entries.length + ")")
                    if (status !== "CURRENT") continue

                    for (var e = 0; e < entries.length; e++) {
                        var entry = entries[e]
                        var media = entry && entry.media
                        if (!media) continue
                        var progress = Number(entry.progress) || 0
                        var total = Number(media.episodes) || 0
                        var title = (media.title && media.title.userPreferred && String(media.title.userPreferred)) || "Unknown"
                        for (var i = 1; i <= EPISODES_AHEAD; i++) {
                            var ep = progress + i
                            if (total && ep > total) break
                            out.push({ mediaId: Number(media.id), title: title, ep: ep, total: total })
                        }
                    }
                }
                debug.set("collection: " + (collection ? "ok" : "missing") +
                    " | lists: " + lists.length +
                    " | " + (seen.join(", ") || "none"))
                rows.set(out)
            } catch (err) {
                debug.set("ERROR: " + String(err))
            }
        }

        tray.onOpen(function () { refresh() })

        tray.render(function () {
            var current = rows.get()
            var items = []
            if (current.length === 0) {
                items.push(tray.text("Nothing found in Currently Watching."))
            } else {
                current.forEach(function (r) {
                    items.push(tray.flex([
                        tray.text(r.title + " - Episode " + r.ep + (r.total ? " / " + r.total : "")),
                        tray.button({
                            label: "Open",
                            onClick: ctx.eventHandler("open-" + r.mediaId + "-" + r.ep, function () {
                                ctx.screen.navigateTo("/entry", { id: String(r.mediaId) })
                            })
                        })
                    ]))
                })
            }
            items.push(tray.text("debug: " + debug.get()))
            return tray.stack(items)
        })
    })
}
