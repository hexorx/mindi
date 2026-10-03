-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: srt
Binary: libsrt1.5-openssl, libsrt1.5-gnutls, libsrt-openssl-dev, libsrt-gnutls-dev, libsrt-doc, srt-tools
Architecture: any all
Version: 1.5.4-1+deb13u1
Maintainer: Florian Ernst <florian@debian.org>
Homepage: https://github.com/Haivision/srt
Standards-Version: 4.7.0
Vcs-Browser: https://salsa.debian.org/debian/libsrt
Vcs-Git: https://salsa.debian.org/debian/libsrt.git
Testsuite: autopkgtest
Testsuite-Triggers: build-essential, libgnutls28-dev, libssl-dev, pkg-config
Build-Depends: debhelper-compat (= 13), cmake, help2man, libgnutls28-dev, libgtest-dev, libssl-dev, pkgconf
Build-Depends-Indep: python3-sphinx
Package-List:
 libsrt-doc deb doc optional arch=all
 libsrt-gnutls-dev deb libdevel optional arch=any
 libsrt-openssl-dev deb libdevel optional arch=any
 libsrt1.5-gnutls deb libs optional arch=any
 libsrt1.5-openssl deb libs optional arch=any
 srt-tools deb utils optional arch=any
Checksums-Sha1:
 04a1ac57e866d2790a9d245ac29bddee8e1db61c 1743040 srt_1.5.4.orig.tar.gz
 e61e90df529ea8e7ede4ea66c7945666bed3ed53 30556 srt_1.5.4-1+deb13u1.debian.tar.xz
Checksums-Sha256:
 d0a8b600fe1b4eaaf6277530e3cfc8f15b8ce4035f16af4a5eb5d4b123640cdd 1743040 srt_1.5.4.orig.tar.gz
 50805bc733bc178d2b98dd8b768db651986819f2f520590060683e8e93d0805a 30556 srt_1.5.4-1+deb13u1.debian.tar.xz
Files:
 08e946bbcdb6f9dc3863de5dd8a48aa3 1743040 srt_1.5.4.orig.tar.gz
 bc6822852a8d5293aab5ccab7e3acdd1 30556 srt_1.5.4-1+deb13u1.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQIzBAEBCgAdFiEEBn03XtJwVyplJ26xBjdBuvXdHs4FAmqDDakACgkQBjdBuvXd
Hs6swA/+Iyq//8PMvdJLCrj6/SxN8ngaZ7vDDOllJobl7tMNqERkADXnVarcWFaP
UWVg/L1fpwFSIz4rh6jufUaLrRKncS6jP2JOquH4M+i0uKWDnHmKtQ4h8V+eyoPO
TZA6mcYPByAXya7BDeSGuZaj9FNcv+LBIQZZvFamp4FElWK98gRRmM7PTIGZmBAQ
DPy/4RVnJQAU+51tHde3bNLvBF+6AZneKaHmIlSAmcwrxlzp7bII/AWF8tWjkToj
c78zeMkuAPPyq5w4P4rrSt5lQ4NVvHXFt4qFmCJeDErHoiP/KgjqNEkOXQ446kyL
da1ngmUsQuq95P6r5YX43qVwJ2pzXV6nDxMLE26A/PGVXJeHCrsAJrk9lsn2UPZA
989GZu5nzDzoraHBLzuBxHm4VHA3wSvIERpHWPQFQXMMb6X8fEHviJ5laH+8c2gC
IIsVMpkhW6jcPKqUOL/UYic3ZOorIqNNjnd+Hb4+GOxpTPHqQtoxos5W1Wt2TygR
6cbm3YSBXaFcG17Q89CyxB2v2ynVQsUJCLShShXS22YzigVByDrGY8zIuHAbugr9
qp6y7QXWkDzdqvQxELU2NIQm+2AOZ7wgCtFisivI2+FaBur/jl3ZEYePpG1zR9zs
m5M4FD4W8PgkmTbX9a+w5D+ZPKU8q2HAL8gcuvDDjcyLsfMM55s=
=7ufh
-----END PGP SIGNATURE-----
