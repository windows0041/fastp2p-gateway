#include "installer.h"
#include "installer_assets.h"
#include "enrollment.h"
#include "protocol.h"
#include <fcntl.h>
#include <inttypes.h>
#include <openssl/evp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *const linux_arches[]={
    "x86_64","aarch64","armv7","i686","riscv64","s390x","ppc64le","mips64el"
};
static const char *const macos_arches[]={"arm64","x86_64"};
static const char *linux_payload_arch(const char *path) {
    int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0)return NULL;
    struct stat metadata;unsigned char h[64];
    ssize_t length=fstat(fd,&metadata) || !S_ISREG(metadata.st_mode)?-1:read(fd,h,sizeof(h));
    close(fd);
    if(length<52 || memcmp(h,"\177ELF",4) || (h[5]!=1 && h[5]!=2))return NULL;
    unsigned machine=h[5]==1?h[18]+256u*h[19]:256u*h[18]+h[19];
    if(h[4]==2 && length==64){
        if(h[5]==2)return machine==22?"s390x":NULL;
        switch(machine){
        case 62:return "x86_64"; case 183:return "aarch64"; case 243:return "riscv64";
        case 21:return "ppc64le"; case 8:return "mips64el"; default:return NULL;
        }
    }
    if(h[4]==1 && h[5]==1){
        if(machine==3)return "i686";
        if(machine==40 && (h[37]&4))return "armv7";
    }
    return NULL;
}
static unsigned linux_payload_arches(const char *path) {
    const char *arch=linux_payload_arch(path);
    for(size_t i=0;arch && i<sizeof(linux_arches)/sizeof(*linux_arches);i++)
        if(!strcmp(arch,linux_arches[i]))return 1u<<i;
    return 0;
}
static unsigned macos_cpu(uint32_t cpu) {
    if(cpu==0x0100000c)return 1u<<0; /* CPU_TYPE_ARM64 */
    if(cpu==0x01000007)return 1u<<1; /* CPU_TYPE_X86_64 */
    return 0;
}
static uint64_t macho_number(const unsigned char *bytes,size_t size,int big_endian) {
    uint64_t number=0;
    for(size_t i=0;i<size;i++)number=(number<<8)|bytes[big_endian?i:size-i-1];
    return number;
}
static unsigned macos_payload_arches(const char *path) {
    int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0)return 0;
    struct stat metadata;
    unsigned char header[32];
    unsigned arches=0;
    if(fstat(fd,&metadata) || !S_ISREG(metadata.st_mode) ||
       read(fd,header,sizeof(header))!=(ssize_t)sizeof(header))goto done;
    uint32_t magic=gw_u32(header);
    if(magic==0xfeedfacf && gw_u32(header+12)==2){ /* MH_EXECUTE */
        arches=macos_cpu(gw_u32(header+4));
        goto done;
    }
    int big_endian=magic==0xbebafeca || magic==0xbfbafeca;
    size_t width=magic==0xbfbafeca || magic==0xcafebabf ? 8 : 4;
    if(!big_endian && magic!=0xcafebabe && magic!=0xcafebabf)goto done;
    uint64_t count=macho_number(header+4,4,big_endian);
    size_t entry_size=width==8?32:20;
    if(count>32 || 8+count*entry_size>(uint64_t)metadata.st_size)goto done;
    for(uint64_t i=0;i<count;i++){
        if(pread(fd,header,entry_size,(off_t)(8+i*entry_size))!=(ssize_t)entry_size)break;
        uint32_t cpu=(uint32_t)macho_number(header,4,big_endian);
        uint64_t offset=macho_number(header+8,width,big_endian);
        uint64_t size=macho_number(header+8+width,width,big_endian);
        if(!macos_cpu(cpu) || offset<8+count*entry_size || offset>(uint64_t)metadata.st_size ||
           size<32 || size>(uint64_t)metadata.st_size-offset)continue;
        if(pread(fd,header,sizeof(header),(off_t)offset)==(ssize_t)sizeof(header) &&
           gw_u32(header)==0xfeedfacf && gw_u32(header+4)==cpu && gw_u32(header+12)==2)
            arches|=macos_cpu(cpu);
    }
done:
    close(fd);
    return arches;
}
const struct gw_installer gw_linux_installer={"linux",linux_arches,sizeof(linux_arches)/sizeof(*linux_arches),
                                              linux_install_script,linux_service_script,linux_payload_arches};
const struct gw_installer gw_macos_installer={"macos",macos_arches,sizeof(macos_arches)/sizeof(*macos_arches),
                                              macos_install_script,NULL,macos_payload_arches};

static int package_valid(const struct gw_installer *installer,const struct gw_install_package *p) {
    int supported=0;
    for(size_t i=0;i<installer->count;i++)if(p->arch && !strcmp(p->arch,installer->arches[i]))supported=1;
    char platform[24];snprintf(platform,sizeof(platform),"%s-%s",installer->platform,p->arch?p->arch:"");
    return supported && (!strcmp(p->platform,installer->platform) || !strcmp(p->platform,platform)) &&
        *p->version && strspn(p->version,"0123456789.")==strlen(p->version) &&
        strlen(p->sha)==64 && strspn(p->sha,"0123456789abcdef")==64 &&
        p->size && p->size<=128u*1024u*1024u;
}
static int cached_valid(const char *path,const char *script,size_t length) {
    int fd=open(path,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0)return 0;
    struct stat metadata;int ok=!fstat(fd,&metadata) && S_ISREG(metadata.st_mode) && (uint64_t)metadata.st_size==length;
    char buffer[65536];size_t offset=0;
    while(ok && offset<length){
        size_t count=length-offset;if(count>sizeof(buffer))count=sizeof(buffer);
        ssize_t used=read(fd,buffer,count);
        if(used<=0 || memcmp(buffer,script+offset,(size_t)used))ok=0;
        else offset+=(size_t)used;
    }
    close(fd);return ok;
}
int gw_build_installer(const struct gw_installer *installer,const char *directory,
                       const char *host,unsigned port,const char *ca,
                       const struct gw_install_package *packages,size_t count,char path[700]) {
    /* A public host may be an IPv6 literal; the URL needs it bracketed. */
    char authority[300];
    gw_host_url_authority(authority,sizeof(authority),host);
    if((!fastp2p_enrollment_host_valid(host) && !gw_is_ipv6_literal(host)) || !port || port>65535 || !ca ||
       strstr(ca,"FASTP2P_DOWNLOAD_CA_EOF") || !count || count>installer->count)return -1;
    for(size_t i=0;i<count;i++)if(!package_valid(installer,packages+i))return -1;
    const char controller[]="@@FASTP2P_CONTROLLER@@\n",download[]="@@FASTP2P_DOWNLOAD@@\n";
    const char *download_at=strstr(installer->script,download);
    const char *controller_at=installer->controller?strstr(installer->script,controller):NULL;
    if(!download_at || (installer->controller && (!controller_at || controller_at<download_at)))return -1;
    char *script=NULL;size_t length=0;
    FILE *memory=open_memstream(&script,&length);if(!memory)return -1;
    fwrite(installer->script,1,(size_t)(download_at-installer->script),memory);
    fprintf(memory,"gateway_url='https://%s:%u'\ndownload_ca=%u\ncase \"$arch\" in\n",authority,port,*ca?1:0);
    for(size_t i=0;i<count;i++){
        const struct gw_install_package *p=packages+i;
        fprintf(memory,"    %s) package_platform='%s'; expected_version='%s'; expected_sha='%s'; expected_size=%" PRIu64 " ;;\n",
                p->arch,p->platform,p->version,p->sha,p->size);
    }
    fputs("    *) fail \"此安装脚本没有 $arch 的客户端包。可用架构：",memory);
    for(size_t i=0;i<count;i++)fprintf(memory,"%s%s",i?"、":"",packages[i].arch);
    fputs("。\" ;;\nesac\n",memory);
    fputs("cat > \"$work/gateway-ca.pem\" <<'FASTP2P_DOWNLOAD_CA_EOF'\n",memory);
    fputs(ca,memory);fputs("\nFASTP2P_DOWNLOAD_CA_EOF\n",memory);
    const char *after_download=download_at+sizeof(download)-1;
    if(controller_at){
        fwrite(after_download,1,(size_t)(controller_at-after_download),memory);
        fputs("cat > \"$work/fastp2p-service\" <<'FASTP2P_SERVICE_EOF'\n",memory);
        fputs(installer->controller,memory);fputs("\nFASTP2P_SERVICE_EOF\n",memory);
        fputs(controller_at+sizeof(controller)-1,memory);
    }else{
        json_object *preset=json_object_new_object();
        gw_js(preset,"host",host);
        gw_ju(preset,"port",port);
        gw_js(preset,"ca",ca);
        fprintf(memory,"cat > \"$work/gateway.json\" <<'FASTP2P_BOOTSTRAP_EOF'\n%s\nFASTP2P_BOOTSTRAP_EOF\n",
                json_object_to_json_string_ext(preset,JSON_C_TO_STRING_PLAIN));
        json_object_put(preset);
        fputs(after_download,memory);
    }
    if(fclose(memory)){free(script);return -1;}
    unsigned char digest[32];unsigned bytes=0;char template_sha[65];
    if(!EVP_Digest(script,length,digest,&bytes,EVP_sha256(),NULL) || bytes!=32){free(script);return -1;}
    for(unsigned i=0;i<32;i++)snprintf(template_sha+2*i,3,"%02x",digest[i]);
    if(snprintf(path,700,"%s/installer-%s-%s.sh",directory,template_sha,packages[0].sha)>=700){free(script);return -1;}
    char lock_path[700];snprintf(lock_path,sizeof(lock_path),"%s/.release.lock",directory);
    int lock=open(lock_path,O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0600);
    if(lock<0 || flock(lock,LOCK_EX|LOCK_NB)){if(lock>=0)close(lock);free(script);return -1;}
    if(cached_valid(path,script,length)){close(lock);free(script);return 0;}
    char temporary[700];
    if(snprintf(temporary,sizeof(temporary),"%s/.installer-XXXXXX",directory)>=(int)sizeof(temporary)){
        close(lock);free(script);return -1;
    }
    int fd=mkstemp(temporary);FILE *output=fd>=0?fdopen(fd,"wb"):NULL;int ok=0;
    if(output){
        ok=fwrite(script,1,length,output)==length && !fflush(output) && !fsync(fd);
        if(fclose(output))ok=0;
    }else if(fd>=0)close(fd);
    if(ok && rename(temporary,path))ok=0;
    if(!ok)unlink(temporary);
    close(lock);free(script);return ok?0:-1;
}
