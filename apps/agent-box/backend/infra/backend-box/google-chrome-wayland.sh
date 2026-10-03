#!/bin/sh
# The desktop runtime supplies the managed display and browser directory.
# Keep those bindings intact; an unbound launch retains Chrome's usual profile.
if [ "${MINDI_CHROME_USER_DATA_DIR+x}" = x ]; then
    case "$MINDI_CHROME_USER_DATA_DIR" in
        /*) ;;
        *) echo 'MINDI_CHROME_USER_DATA_DIR must be absolute and non-empty' >&2; exit 2 ;;
    esac
    for arg do
        case "$arg" in
            --user-data-dir|--user-data-dir=*|-user-data-dir|-user-data-dir=*)
                echo '--user-data-dir is managed by MINDI_CHROME_USER_DATA_DIR' >&2
                exit 2
                ;;
        esac
    done
    set -- "--user-data-dir=$MINDI_CHROME_USER_DATA_DIR" "$@"
fi
exec /usr/bin/google-chrome-stable \
    --ozone-platform=wayland \
    --enable-features=UseOzonePlatform \
    --disable-dev-shm-usage \
    --no-sandbox \
    --disable-setuid-sandbox \
    --no-first-run \
    --disable-gpu \
    --force-renderer-accessibility \
    "$@"
