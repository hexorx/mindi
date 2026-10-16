-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA256

Format: 3.0 (quilt)
Source: chromium
Binary: chromium, chromium-l10n, chromium-shell, chromium-headless-shell, chromium-driver, chromium-common, chromium-sandbox
Architecture: i386 amd64 arm64 armhf loong64 ppc64el all
Version: 154.0.8037.92-1~deb13u1
Maintainer: Debian Chromium Team <chromium@packages.debian.org>
Uploaders:  Andres Salomon <dilinger@debian.org>, Timothy Pearson <tpearson@raptorengineering.com>, Daniel Richard G. <skunk@iSKUNK.ORG>,
Homepage: http://www.chromium.org/Home
Standards-Version: 4.5.0
Vcs-Browser: https://salsa.debian.org/chromium-team/chromium
Vcs-Git: https://salsa.debian.org/chromium-team/chromium.git
Build-Depends: debhelper (>= 11), devscripts, llvm-22:native, lld-22:native, clang-22:native, clang-format-22:native, libclang-rt-22-dev, libc++-22-dev, rustc-web:any (>= 1.96.0), libstd-rust-web-dev (>= 1.96.0), bindgen:native, rustfmt:any, python3:any, pkgconf, ninja-build, python3-jinja2:native, ca-certificates, wget, flex, xvfb, wdiff, golang, gperf, bison, nodejs:any, node-rollup-plugin-terser:native, node-typescript, rollup, esbuild:native, xz-utils, xcb-proto, xfonts-base, libdav1d-dev, libx11-xcb-dev, libxshmfence-dev, libgl-dev, libglu1-mesa-dev, libegl1-mesa-dev, libgles2-mesa-dev, libopenh264-dev, mesa-common-dev, rapidjson-dev, libva-dev, libxt-dev, libgbm-dev, libpng-dev, libxss-dev, libelf-dev, libpci-dev, libcap-dev, libffi-dev, libkrb5-dev, libexif-dev, libflac-dev, libudev-dev, libpipewire-0.3-dev, libpthreadpool-dev, libopus-dev, libxtst-dev, libjpeg-dev, libgtk-3-dev, liblcms2-dev, libpulse-dev, libpam0g-dev, libdouble-conversion-dev, libxnvctrl-dev, libglib2.0-dev, libasound2-dev, libsecret-1-dev, libspeechd-dev, libminizip-dev, libhunspell-dev, libharfbuzz-dev, libxcb-dri3-dev, libusb-1.0-0-dev, libopenjp2-7-dev, libnss3-dev, libnspr4-dev, libcups2-dev, libevdev-dev, libgcrypt20-dev, libcurl4-openssl-dev, libzstd-dev, fonts-ipafont-gothic, fonts-ipafont-mincho, cross-exe-wrapper <cross>, linux-libc-dev (>= 6.5)
Build-Conflicts: bindgen-0.56, bindgen-0.65, rustc-1.74
Package-List:
 chromium deb web optional arch=i386,amd64,arm64,armhf,loong64,ppc64el
 chromium-common deb web optional arch=i386,amd64,arm64,armhf,loong64,ppc64el
 chromium-driver deb web optional arch=i386,amd64,arm64,armhf,loong64,ppc64el
 chromium-headless-shell deb web optional arch=i386,amd64,arm64,armhf,loong64,ppc64el
 chromium-l10n deb localization optional arch=all
 chromium-sandbox deb web optional arch=i386,amd64,arm64,armhf,loong64,ppc64el
 chromium-shell deb web optional arch=i386,amd64,arm64,armhf,loong64,ppc64el
Checksums-Sha1:
 971bd0c616f73b93c555e45aaafea6a7b4bf33d3 16689032 chromium_154.0.8037.92.orig-pre-gen.tar.xz
 eab6649cbb68eeb184a5a899fda828988ac0b608 995122080 chromium_154.0.8037.92.orig.tar.xz
 c26330e333ecd800d9c3b70714ea68302e532a28 575700 chromium_154.0.8037.92-1~deb13u1.debian.tar.xz
Checksums-Sha256:
 d8316f2d3cbe1ab942629b9b1044166f33ca9575478feac814a31463c81e8cbe 16689032 chromium_154.0.8037.92.orig-pre-gen.tar.xz
 d5a37fdb95f8c2d24f505f36824540158367d20101f47623e93670cbda006e7e 995122080 chromium_154.0.8037.92.orig.tar.xz
 e347d1dca5a28add92495339bd528be6c8cbdd771427dd6d5b354c85e8e44909 575700 chromium_154.0.8037.92-1~deb13u1.debian.tar.xz
Files:
 e2bbef87a3ae1828a7d523507e0fbe11 16689032 chromium_154.0.8037.92.orig-pre-gen.tar.xz
 49e6d74714cbed79ccb64da86f35c830 995122080 chromium_154.0.8037.92.orig.tar.xz
 787c8dec302378150b5b4ff79f36671f 575700 chromium_154.0.8037.92-1~deb13u1.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQJIBAEBCAAyFiEEUAUk+X1YiTIjs19qZF0CR8NudjcFAmq9TOIUHGRpbGluZ2Vy
QGRlYmlhbi5vcmcACgkQZF0CR8NudjdaQw/+J5+HFRPlmG3RKlKCUNJiTfIkzSqY
kc/cZK7nejkWnmOp6Fokj2dncIv2K0DtZ9NrUwKuzV6TtbZwyNh5dlgwIjJC27Ek
Ug5JhznsusEgN+NRNZYenig+sXnOsypTjU+Z1uXk5zPmxjjYgRYHmBirbRm5Xutr
9qmS/8u6rZklo/NMOj889NlB9Nn5dlkxU1Kkuhv31QXaRlvjT7bGGoRTmNVAQ+Iy
vSNqnHIB8VkSYcxT/ib62ybT10ayJxQuL+ZA+jK0Dit7pRQnpmeaVyp3vHNab+Nm
8bB/2Jp93h/7y3c8ShdvJfJYUy5wQLtIz5FYpUv6LP7XYDUuPQdh6QSnA7MfZkLS
qLcgHcTXUhOSIqC5jyr0BNOSOyASg4bBjMlsaymJ4MsgksaNNcSRZrIGaNYkeZsL
MU0qE7L5lRndlsKVj4CRp8F5GnuzEd+bfWtvoQ3jK+Gfi+xWx6v/nlbTnHgfk1Fs
pm7Lx06LrbduMRAyI312aTclMI8YsL0henE/35X+IqXK6jRwXnkKs0HqqbFfWcxx
iW3bBOaun+4ow/GrWyyZstfi1GOGTA7F6UKs+V6ihQaOlpGAVxtL/gE3vP+Ni/Dv
mgp8x7yrLYbWmmZuEq02BGDx1FI//jhblFXi3xB4Fl3fgkDiT1WfeVkqn439XjD2
PwC7XJafqG6gxJ0=
=3DAf
-----END PGP SIGNATURE-----
