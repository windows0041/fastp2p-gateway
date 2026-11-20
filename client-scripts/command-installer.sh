#!/bin/sh
set -eu
umask 077

if [ "$#" -ne 2 ] || [ "$1" != --token ]; then
    printf '%s\n' 'Usage: sh -s -- --token 16_DIGITS' >&2
    exit 2
fi
token=$2
case "$token" in
    0*|*[!0-9]*) token='' ;;
esac
if [ "${#token}" -ne 16 ]; then
    printf '%s\n' 'fastp2p: --token requires a 16-digit installation token.' >&2
    exit 2
fi
