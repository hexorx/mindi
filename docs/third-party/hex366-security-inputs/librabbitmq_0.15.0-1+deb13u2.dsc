-----BEGIN PGP SIGNED MESSAGE-----
Hash: SHA512

Format: 3.0 (quilt)
Source: librabbitmq
Binary: amqp-tools, librabbitmq-dev, librabbitmq4
Architecture: any
Version: 0.15.0-1+deb13u2
Maintainer: Florian Ernst <florian@debian.org>
Homepage: https://github.com/alanxz/rabbitmq-c
Standards-Version: 4.7.0
Vcs-Browser: https://salsa.debian.org/debian/librabbitmq
Vcs-Git: https://salsa.debian.org/debian/librabbitmq.git
Testsuite: autopkgtest
Testsuite-Triggers: @builddeps@
Build-Depends: cmake, debhelper-compat (= 13), xmlto, libpopt-dev, libssl-dev, libtool
Package-List:
 amqp-tools deb net optional arch=any
 librabbitmq-dev deb libdevel optional arch=any
 librabbitmq4 deb libs optional arch=any
Checksums-Sha1:
 26a1d0f61fa1198cbfd22cb246e88f667bb8299e 131818 librabbitmq_0.15.0.orig.tar.gz
 3874a330f0118abec914590136c77de456d080ac 10560 librabbitmq_0.15.0-1+deb13u2.debian.tar.xz
Checksums-Sha256:
 7b652df52c0de4d19ca36c798ed81378cba7a03a0f0c5d498881ae2d79b241c2 131818 librabbitmq_0.15.0.orig.tar.gz
 379c5a83477ee5f09f5d82fcd80d689b683ba5f5e024caa3a8f3cd664c3a72a6 10560 librabbitmq_0.15.0-1+deb13u2.debian.tar.xz
Files:
 719e96cb3cd9e2c16f3e9cf3b47b8746 131818 librabbitmq_0.15.0.orig.tar.gz
 3828584ccb457fad51ef8fc9613cb70c 10560 librabbitmq_0.15.0-1+deb13u2.debian.tar.xz

-----BEGIN PGP SIGNATURE-----

iQIzBAEBCgAdFiEEBn03XtJwVyplJ26xBjdBuvXdHs4FAmqEhk4ACgkQBjdBuvXd
Hs7UvQ/+MJOy67PhDygZW15qd2Pid4ODHrz2dbV6U9YYKX1je3G5qayxt2y/hYMX
R6Ar1cxkzcw2hocmQ8FdYMEJkld2zq9Y6JFxrCgrzNm3LXqmaMXYKvDb7nIElcgI
tEqoDg2uVKani685gn5uPck8R3JnCJx+7WA9e8FPxiFnHEaw1nkj7PBw2Sx4vY7Z
NX2JlQvhoQ44LnssA28A/piKfqqOUyZiZk0eDF7TL/YQreBIQrIQRO4FG+WLmMB3
wmj35UNpo3TGNofHuKqBWLucnf7HZv9a/dfMTClHq3V0BjG6xv6N6+rdjeuJo3ml
0HiLtK6ZngtyQraQOzpsSUYXUzbI9bJ9ln4F6YMlKqB0Xs2f9c7Astt+uhdfhDAz
0JOpRUJtE099aHO5r13+ZOa27c/4ReMx24X11uJaX4wdFh2cx6bCjxcqmVHSlwQq
7PvEh04c8bqqLvqOqyNQCrv86ZWcut9L+sJO2GTPZqFkpFNn1XN7HNjvGtMC3gk6
f1E4LWwSdzPz0duKaJAH4bk4P5Biw9Ju3ZmawOngzL1tNtCuABYu7QfVwr8wu5dj
wGlJaOXYTVB0KXpB6zA53Q7DWE6M8SFAtDyn6szEKUN0QZE/SgekuNVRGARx1dKq
UsgGKA23ViR14aptWsdnlhBywv7AlGl2GWyLOg3xBfPSnemRoDs=
=OqUN
-----END PGP SIGNATURE-----
