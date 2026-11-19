#ifndef FASTP2P_INSTALLER_H
#define FASTP2P_INSTALLER_H
#include <stdint.h>
#include <stddef.h>
#define GW_INSTALLER_MAX_ARCHES 8
struct gw_installer {
    const char *platform;
    const char *const *arches;
    size_t count;
    const char *script, *controller;
    unsigned (*payload_arches)(const char *path);
};
extern const struct gw_installer gw_linux_installer, gw_macos_installer;
struct gw_install_package {
    const char *arch;
    char platform[16],version[32],sha[65];
    uint64_t size;
};
/* Ticket downloads include the account token in memory and are never cached. */
int gw_render_installer(const struct gw_installer *installer, const char *host,
                        unsigned port, const char *ca, const struct gw_install_package *packages,
                        size_t count, uint64_t token, char **script, size_t *length);
/* Immutable token-free downloader; the selected executables remain on the gateway. */
int gw_build_installer(const struct gw_installer *installer, const char *directory,
                       const char *host, unsigned port, const char *ca,
                       const struct gw_install_package *packages, size_t count, char path[700]);
#endif
