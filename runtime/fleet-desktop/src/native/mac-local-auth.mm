#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_deferred__* napi_deferred;
typedef struct napi_callback_info__* napi_callback_info;
typedef struct napi_threadsafe_function__* napi_threadsafe_function;

typedef enum { napi_ok = 0 } napi_status;
typedef enum { napi_tsfn_nonblocking = 0 } napi_threadsafe_function_call_mode;
typedef enum { napi_tsfn_release = 0 } napi_threadsafe_function_release_mode;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);
typedef void (*napi_threadsafe_function_call_js)(napi_env env, napi_value js_callback, void* context, void* data);

typedef struct {
  const char* utf8name;
  napi_value name;
  napi_callback method;
  napi_callback getter;
  napi_callback setter;
  napi_value value;
  uint32_t attributes;
  void* data;
} napi_property_descriptor;

typedef struct {
  int nm_version;
  uint32_t nm_flags;
  const char* nm_filename;
  napi_value (*nm_register_func)(napi_env env, napi_value exports);
  const char* nm_modname;
  void* nm_priv;
  void* reserved[4];
} napi_module;

extern "C" {
napi_status napi_get_boolean(napi_env env, bool value, napi_value* result);
napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv, napi_value* this_arg, void** data);
napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char* buf, size_t bufsize, size_t* result);
napi_status napi_create_string_utf8(napi_env env, const char* str, size_t length, napi_value* result);
napi_status napi_create_error(napi_env env, napi_value code, napi_value msg, napi_value* result);
napi_status napi_create_promise(napi_env env, napi_deferred* deferred, napi_value* promise);
napi_status napi_resolve_deferred(napi_env env, napi_deferred deferred, napi_value resolution);
napi_status napi_reject_deferred(napi_env env, napi_deferred deferred, napi_value rejection);
napi_status napi_get_undefined(napi_env env, napi_value* result);
napi_status napi_create_threadsafe_function(napi_env env, napi_value func, napi_value async_resource, napi_value async_resource_name, size_t max_queue_size, size_t initial_thread_count, void* thread_finalize_data, void* thread_finalize_cb, void* context, napi_threadsafe_function_call_js call_js_cb, napi_threadsafe_function* result);
napi_status napi_call_threadsafe_function(napi_threadsafe_function func, void* data, napi_threadsafe_function_call_mode is_blocking);
napi_status napi_release_threadsafe_function(napi_threadsafe_function func, napi_threadsafe_function_release_mode mode);
napi_status napi_define_properties(napi_env env, napi_value object, size_t property_count, const napi_property_descriptor* properties);
void napi_module_register(napi_module* mod);
}

namespace {

struct AuthResult {
  napi_deferred deferred;
  bool ok;
  const char* code;
};

void CallJsFinish(napi_env env, napi_value /*js_callback*/, void* /*context*/, void* data) {
  AuthResult* res = static_cast<AuthResult*>(data);
  if (!res) return;
  if (env) {
    if (res->ok) {
      napi_value undef = nullptr;
      napi_get_undefined(env, &undef);
      napi_resolve_deferred(env, res->deferred, undef);
    } else {
      napi_value msg = nullptr;
      napi_value err = nullptr;
      const char* code = res->code ? res->code : "os_auth_failed";
      napi_create_string_utf8(env, code, strlen(code), &msg);
      napi_create_error(env, msg, msg, &err);
      napi_reject_deferred(env, res->deferred, err);
    }
  }
  free(res);
}

const char* MapLAErrorCode(NSError* error) {
  if (!error) return "os_auth_failed";
  switch (error.code) {
    case LAErrorUserCancel:
    case LAErrorSystemCancel:
    case LAErrorAppCancel:
      return "os_auth_cancelled";
    case LAErrorPasscodeNotSet:
    case LAErrorBiometryNotAvailable:
      return "os_auth_unavailable";
    default:
      return "os_auth_failed";
  }
}

napi_value CanAuthenticate(napi_env env, napi_callback_info /*info*/) {
  @autoreleasepool {
    LAContext* ctx = [[LAContext alloc] init];
    NSError* err = nil;
    BOOL ok = [ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&err];
    napi_value result = nullptr;
    napi_get_boolean(env, ok == YES, &result);
    return result;
  }
}

napi_value Authenticate(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1] = {nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  char reasonBuf[512] = "Authenticate to view saved passwords";
  if (argc >= 1 && argv[0]) {
    size_t len = 0;
    napi_get_value_string_utf8(env, argv[0], reasonBuf, sizeof(reasonBuf), &len);
  }

  napi_deferred deferred = nullptr;
  napi_value promise = nullptr;
  if (napi_create_promise(env, &deferred, &promise) != napi_ok) return nullptr;

  napi_value asyncName = nullptr;
  napi_create_string_utf8(env, "FleetMacLocalAuth", 17, &asyncName);
  napi_threadsafe_function tsfn = nullptr;
  if (napi_create_threadsafe_function(env, nullptr, nullptr, asyncName, 0, 1, nullptr, nullptr, nullptr, CallJsFinish, &tsfn) != napi_ok) {
    napi_value msg = nullptr;
    napi_value err = nullptr;
    napi_create_string_utf8(env, "os_auth_failed", 14, &msg);
    napi_create_error(env, msg, msg, &err);
    napi_reject_deferred(env, deferred, err);
    return promise;
  }

  @autoreleasepool {
    LAContext* ctx = [[LAContext alloc] init];
    NSError* checkErr = nil;
    if (![ctx canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&checkErr]) {
      AuthResult* res = static_cast<AuthResult*>(malloc(sizeof(AuthResult)));
      res->deferred = deferred;
      res->ok = false;
      res->code = MapLAErrorCode(checkErr);
      napi_call_threadsafe_function(tsfn, res, napi_tsfn_nonblocking);
      napi_release_threadsafe_function(tsfn, napi_tsfn_release);
      return promise;
    }

    NSString* reason = [NSString stringWithUTF8String:reasonBuf];
    if (!reason || reason.length == 0) reason = @"Authenticate to view saved passwords";
    [ctx evaluatePolicy:LAPolicyDeviceOwnerAuthentication localizedReason:reason reply:^(BOOL success, NSError* error) {
      AuthResult* res = static_cast<AuthResult*>(malloc(sizeof(AuthResult)));
      res->deferred = deferred;
      res->ok = (success == YES);
      res->code = (success == YES) ? nullptr : MapLAErrorCode(error);
      napi_call_threadsafe_function(tsfn, res, napi_tsfn_nonblocking);
      napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    }];
  }
  return promise;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descs[] = {
    {"canAuthenticate", nullptr, CanAuthenticate, nullptr, nullptr, nullptr, 0, nullptr},
    {"authenticate", nullptr, Authenticate, nullptr, nullptr, nullptr, 0, nullptr},
  };
  napi_define_properties(env, exports, 2, descs);
  return exports;
}

napi_module mod = {
  1,
  0,
  __FILE__,
  Init,
  "mac_local_auth",
  nullptr,
  {nullptr, nullptr, nullptr, nullptr},
};

}  // namespace

__attribute__((constructor)) static void register_mac_local_auth() {
  napi_module_register(&mod);
}
