(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  const React = SDK.React;
  const { useEffect, useState } = SDK.hooks;
  const { Button, Card, CardContent, CardHeader, CardTitle } = SDK.components;

  const API = "/api/plugins/mindi-box";

  function BoxPage() {
    const [status, setStatus] = useState(null);
    const [message, setMessage] = useState("");
    const [userCode, setUserCode] = useState("");
    const [verifyUri, setVerifyUri] = useState("");
    const [busy, setBusy] = useState(false);

    function refresh() {
      SDK.fetchJSON(`${API}/status`)
        .then(setStatus)
        .catch(function (err) {
          setMessage(String(err));
        });
    }

    useEffect(function () {
      refresh();
    }, []);

    async function startGithub() {
      setMessage("");
      setUserCode("");
      setVerifyUri("");
      setBusy(true);
      try {
        const res = await SDK.authedFetch(`${API}/github-oauth/start`, {
          method: "POST",
        });
        const started = await res.json();
        if (!started.ok) {
          setMessage(started.error || "start failed");
          setBusy(false);
          return;
        }
        setUserCode(started.user_code);
        setVerifyUri(started.verification_uri);
        let intervalMs = (started.interval || 5) * 1000;
        const pollId = started.poll_id;
        let timer = null;

        async function tick() {
          try {
            const pollRes = await SDK.authedFetch(`${API}/github-oauth/poll`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ poll_id: pollId }),
            });
            const result = await pollRes.json();
            if (result.status === "pending") {
              if (result.interval) {
                intervalMs = result.interval * 1000;
                if (timer) clearInterval(timer);
                timer = setInterval(tick, intervalMs);
              }
              return;
            }
            if (timer) clearInterval(timer);
            setBusy(false);
            if (result.status === "wrong_account") {
              setMessage(
                "Signed in as " +
                  result.login +
                  ", expected " +
                  result.expected +
                  ".",
              );
              return;
            }
            if (result.status === "ok") {
              refresh();
              setMessage(
                result.replaced
                  ? "Token saved. Run /gateway restart."
                  : "Token saved. Identity watch will start the gateway.",
              );
              return;
            }
            setMessage(result.error || "oauth failed");
          } catch (err) {
            if (timer) clearInterval(timer);
            setBusy(false);
            setMessage(String(err));
          }
        }

        timer = setInterval(tick, intervalMs);
      } catch (err) {
        setBusy(false);
        setMessage(String(err));
      }
    }

    const owner = (status && status.githubOwner) || "";
    return React.createElement(
      "div",
      { className: "flex flex-col gap-4 p-4" },
      React.createElement(
        Card,
        null,
        React.createElement(CardHeader, null, React.createElement(CardTitle, null, "Agent box")),
        React.createElement(
          CardContent,
          { className: "grid gap-2 text-sm" },
          React.createElement("div", null, "GitHub owner: ", React.createElement("code", null, owner || "unset")),
          React.createElement(
            "div",
            null,
            "gh identity: ",
            status
              ? status.ghLogin
                ? status.ghLogin
                : status.hasToken
                  ? "token present"
                  : "no token"
              : "loading",
          ),
          React.createElement("div", null, "Hindsight: ", status ? status.hindsight : "loading"),
          React.createElement("div", null, "noVNC: ", status ? status.novnc : "loading"),
          status && status.personaRepo
            ? React.createElement(
                "div",
                null,
                "Persona ",
                React.createElement(
                  "a",
                  {
                    className: "underline",
                    href: `https://github.com/${status.personaRepo}`,
                    target: "_blank",
                    rel: "noreferrer",
                  },
                  status.personaRepo,
                ),
              )
            : null,
          status && status.dotfilesRepo
            ? React.createElement(
                "div",
                null,
                "Dotfiles ",
                React.createElement(
                  "a",
                  {
                    className: "underline",
                    href: `https://github.com/${status.dotfilesRepo}`,
                    target: "_blank",
                    rel: "noreferrer",
                  },
                  status.dotfilesRepo,
                ),
              )
            : null,
        ),
      ),
      React.createElement(
        Card,
        null,
        React.createElement(CardHeader, null, React.createElement(CardTitle, null, "GitHub")),
        React.createElement(
          CardContent,
          { className: "flex flex-col gap-3" },
          React.createElement(
            "p",
            { className: "text-sm text-muted-foreground" },
            "Authorize as the service account (",
            React.createElement("code", null, owner || "GITHUB_OWNER"),
            "), not your personal user.",
          ),
          React.createElement(
            Button,
            { type: "button", onClick: startGithub, disabled: busy },
            "Sign in with GitHub",
          ),
          userCode
            ? React.createElement(
                "p",
                { className: "text-sm" },
                "Enter ",
                React.createElement("code", null, userCode),
                " at ",
                React.createElement(
                  "a",
                  {
                    className: "underline",
                    href: verifyUri || "https://github.com/login/device",
                    target: "_blank",
                    rel: "noreferrer",
                  },
                  verifyUri || "https://github.com/login/device",
                ),
              )
            : null,
          message ? React.createElement("p", { className: "text-sm" }, message) : null,
        ),
      ),
    );
  }

  window.__HERMES_PLUGINS__.register("mindi-box", BoxPage);
})();
