(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const React = SDK.React;
  const DESKTOP_SRC =
    "/api/plugins/mindi-box/novnc/vnc.html?autoconnect=1&resize=scale&path=/api/plugins/mindi-box/websockify";

  function DesktopPage() {
    return React.createElement(
      "div",
      {
        style: {
          position: "absolute",
          inset: 0,
          overflow: "hidden",
        },
      },
      React.createElement("iframe", {
        title: "noVNC desktop",
        src: DESKTOP_SRC,
        style: {
          width: "100%",
          height: "100%",
          border: 0,
          display: "block",
        },
      }),
    );
  }

  window.__HERMES_PLUGINS__.register("mindi-desktop", DesktopPage);
})();
