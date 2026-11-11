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

        function refresh() {
            var collection = $anilist.getAnimeCollection(false)
            var lists = (collection && collection.MediaListCollection && collection.MediaListCollection.lists) || []
            var out = []

            for (var l = 0; l < lists.length; l++) {
                var list = lists[l]
                if (!list || list.status !== "CURRENT") continue
                var entries = list.entries || []
                for (var e = 0; e < entries.length; e++) {
                    var entry = entries[e]
                    var media = entry && entry.media
                    if (!media) continue
                    var progress = entry.progress || 0
                    var total = media.episodes || 0
                    var title = (media.title && media.title.userPreferred) || "Unknown"
                    for (var i = 1; i <= EPISODES_AHEAD; i++) {
                        var ep = progress + i
                        if (total && ep > total) break
                        out.push({ mediaId: media.id, title: title, ep: ep, total: total })
                    }
                }
            }
            rows.set(out)
        }

        tray.onOpen(function () { refresh() })

        tray.render(function () {
            var current = rows.get()
            if (current.length === 0) {
                return tray.stack([tray.text("Nothing in your Currently Watching list.")])
            }
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
