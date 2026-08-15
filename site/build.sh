#!/bin/sh
# AdLayer advertiser site — the entire build.
#
# Substitute the Stripe Payment Link into index.html, but ONLY if one is set.
# With no STRIPE_PAYMENT_LINK the placeholder survives and the page renders its
# explicit "payment link not configured" state. There is deliberately no
# fallback URL and no default link: a checkout button that goes somewhere
# unintended is worse than no button.
#
# The site is fully functional with this script never run.

set -eu

if [ -z "${STRIPE_PAYMENT_LINK:-}" ]; then
  echo "build: STRIPE_PAYMENT_LINK is not set — leaving the checkout in its unconfigured state"
  exit 0
fi

case "$STRIPE_PAYMENT_LINK" in
  https://*) ;;
  *)
    echo "build: STRIPE_PAYMENT_LINK is not an https URL — refusing to substitute it" >&2
    exit 1
    ;;
esac

# `|` as the delimiter because the value is a URL full of slashes. Write via a
# temp file rather than `sed -i`, whose argument handling differs between GNU
# and BSD sed — Render is Linux, a laptop may not be, and a build script that
# only works on the deploy host is a build script nobody tests.
sed "s|__STRIPE_PAYMENT_LINK__|${STRIPE_PAYMENT_LINK}|g" index.html > index.html.tmp
mv index.html.tmp index.html
echo "build: checkout wired to ${STRIPE_PAYMENT_LINK}"
