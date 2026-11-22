#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/* This name is the coordination protocol across checkouts. Never unlink the
 * rendezvous or use its contents, mtime or a PID as evidence of occupancy. */
#ifndef LOCK_DIRECTORY
#define LOCK_DIRECTORY "fleet-console-e2e-measurement"
#endif
#define LOCK_NAME "focus.lock"

static int has_no_acl(int fd) {
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (!acl) return errno == ENOENT;
    acl_entry_t entry;
    int empty = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == -1 && errno == EINVAL;
    acl_free(acl);
    return empty;
}

static int private_file(const struct stat *st, uid_t uid) {
    return S_ISREG(st->st_mode) && st->st_uid == uid && (st->st_mode & 07777) == 0600 &&
        st->st_nlink == 1 && st->st_size == 0;
}

static napi_value lock_error(napi_env env, const char *stage, int number) {
    char detail[96];
    snprintf(detail, sizeof(detail), "%s (errno %d)", stage, number);
    napi_throw_error(env, "measurement_lock_failed", detail);
    return NULL;
}

static int open_rendezvous_root(void) {
    char user_dir[PATH_MAX];
    /* Use the stable OS user directory, not the purgeable temp/cache directory
     * or the isolated wrapper's TMPDIR. */
    size_t length = confstr(_CS_DARWIN_USER_DIR, user_dir, sizeof(user_dir));
    if (!length || length > sizeof(user_dir)) { errno = EINVAL; return -1; }
    if (length > 1 && user_dir[length - 2] == '/') user_dir[length - 2] = '\0';
    /* Darwin commonly reports the system /var alias. Spell that known alias
     * explicitly rather than resolving arbitrary symlinks in the actual path. */
    const int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC;
    if (strncmp(user_dir, "/private/var/folders/", sizeof("/private/var/folders/") - 1) == 0) {
        return open(user_dir, flags);
    }
    if (strncmp(user_dir, "/var/folders/", sizeof("/var/folders/") - 1) == 0) {
        char canonical[PATH_MAX];
        int size = snprintf(canonical, sizeof(canonical), "/private%s", user_dir);
        if (size >= 0 && (size_t)size < sizeof(canonical)) return open(canonical, flags);
    }
    errno = EINVAL;
    return -1;
}

static napi_value acquire(napi_env env, napi_callback_info info) {
    (void)info;
    uid_t uid = getuid();
    if (uid == 0 || uid != geteuid()) return lock_error(env, "user_identity", EPERM);
    int root = open_rendezvous_root();
    if (root < 0) return lock_error(env, "rendezvous_root_open", errno);
    struct stat st;
    if (fstat(root, &st) < 0 || st.st_uid != uid || (st.st_mode & 0022) != 0 || !has_no_acl(root)) {
        close(root);
        return lock_error(env, "rendezvous_root_unverified", EPERM);
    }
    if (mkdirat(root, LOCK_DIRECTORY, 0700) < 0 && errno != EEXIST) {
        int error = errno;
        close(root);
        return lock_error(env, "rendezvous_directory_create", error);
    }
    int dir = openat(root, LOCK_DIRECTORY, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    int directory_error = errno;
    close(root);
    if (dir < 0) return lock_error(env, "rendezvous_directory_open", directory_error);
    if (fstat(dir, &st) < 0 || st.st_uid != uid || (st.st_mode & 07777) != 0700 || !has_no_acl(dir)) {
        close(dir);
        return lock_error(env, "rendezvous_directory_unverified", EPERM);
    }
    /* Inspect an existing name without following it, and repeat the check on
     * the opened inode. The shared directory is only writable by these peers. */
    if (fstatat(dir, LOCK_NAME, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        if (!private_file(&st, uid)) {
            close(dir);
            return lock_error(env, "rendezvous_file_unverified", EPERM);
        }
    } else if (errno != ENOENT) {
        int error = errno;
        close(dir);
        return lock_error(env, "rendezvous_file_stat", error);
    }
    int fd = openat(dir, LOCK_NAME, O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0600);
    int error = errno;
    close(dir);
    if (fd < 0) return lock_error(env, "rendezvous_file_open", error);
    if (fstat(fd, &st) < 0 || !private_file(&st, uid) || !has_no_acl(fd)) {
        close(fd);
        return lock_error(env, "rendezvous_file_unverified", EPERM);
    }
    napi_value result;
    if (flock(fd, LOCK_EX | LOCK_NB) < 0) {
        error = errno;
        close(fd);
        if (error != EWOULDBLOCK) return lock_error(env, "rendezvous_flock", error);
        napi_get_null(env, &result);
    } else if (napi_create_int32(env, fd, &result) != napi_ok) {
        close(fd);
        return lock_error(env, "rendezvous_return_fd", EIO);
    }
    return result;
}

NAPI_MODULE_INIT() {
    napi_value fn;
    if (napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "acquire", fn) != napi_ok) {
        return lock_error(env, "addon_init", EIO);
    }
    return exports;
}
