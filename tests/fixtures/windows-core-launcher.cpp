// QA-only native equivalent of controlled-core.sh. Not packaged with Synora.
// Preserve original Core, argv, inherited environment and stdio. Never invoke
// cmd.exe/PowerShell or rewrite protocol messages. The optional endpoint is a
// loopback-only original Core config override for the controlled test server.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>
#include <vector>

static std::wstring quote(const std::wstring& value) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    out.append(c == L'\"' ? slashes * 2 + 1 : slashes, L'\\');
    slashes = 0;
    out += c;
  }
  out.append(slashes * 2, L'\\');
  return out + L'\"';
}
static std::wstring setting(const std::wstring& ini, const wchar_t* key) {
  std::vector<wchar_t> buffer(32768);
  const DWORD size = GetPrivateProfileStringW(
      L"launcher", key, L"", buffer.data(), static_cast<DWORD>(buffer.size()),
      ini.c_str());
  if (size >= buffer.size() - 1) throw L"Launcher setting exceeds limit";
  return std::wstring(buffer.data(), size);
}
static bool validEndpoint(const std::wstring& value) {
  const std::wstring prefix = L"http://127.0.0.1:";
  const std::wstring suffix = L"/v1";
  if (value.compare(0, prefix.size(), prefix) != 0 ||
      value.size() <= prefix.size() + suffix.size() ||
      value.compare(value.size() - suffix.size(), suffix.size(), suffix) != 0)
    return false;
  const auto portText = value.substr(prefix.size(), value.size() - prefix.size() - suffix.size());
  if (portText.size() > 5) return false;
  unsigned port = 0;
  for (wchar_t c : portText) {
    if (c < L'0' || c > L'9') return false;
    port = port * 10 + static_cast<unsigned>(c - L'0');
  }
  return port > 0 && port <= 65535;
}
int wmain(int argc, wchar_t** argv) {
  try {
    std::vector<wchar_t> name(32768);
    const DWORD count = GetModuleFileNameW(nullptr, name.data(), static_cast<DWORD>(name.size()));
    if (!count || count == name.size()) throw L"Cannot resolve QA launcher";
    const std::wstring self(name.data(), count), ini = self + L".ini";
    const auto core = setting(ini, L"executable");
    const auto endpoint = setting(ini, L"endpoint");
    if (core.size() < 4 || core[1] != L':' ||
        (core[2] != L'\\' && core[2] != L'/') ||
        GetFileAttributesW(core.c_str()) == INVALID_FILE_ATTRIBUTES ||
        _wcsicmp(core.c_str(), self.c_str()) == 0)
      throw L"An existing absolute original executable is required";
    if (!endpoint.empty() && !validEndpoint(endpoint))
      throw L"Only an explicit loopback controlled-provider endpoint is allowed";
    std::wstring command = quote(core);
    for (int i = 1; i < argc; ++i) command += L" " + quote(argv[i]);
    if (!endpoint.empty() && !(argc == 2 && std::wstring(argv[1]) == L"--version")) {
      command += L" -c " + quote(L"openai_base_url=\"" + endpoint + L"\"");
    }
    if (command.size() >= 32767) throw L"Windows command-line limit exceeded";
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    PROCESS_INFORMATION child{};
    if (!CreateProcessW(core.c_str(), command.data(), nullptr, nullptr, TRUE,
                        0, nullptr, nullptr, &startup, &child)) {
      std::fwprintf(stderr, L"QA launcher CreateProcess failed: %lu\n", GetLastError());
      return 124;
    }
    CloseHandle(child.hThread);
    DWORD status = 125;
    const DWORD wait = WaitForSingleObject(child.hProcess, INFINITE);
    const BOOL exited = wait == WAIT_OBJECT_0 && GetExitCodeProcess(child.hProcess, &status);
    CloseHandle(child.hProcess);
    if (!exited) throw L"Cannot collect original executable status";
    return static_cast<int>(status);
  } catch (const wchar_t* error) {
    std::fwprintf(stderr, L"QA launcher: %ls\n", error);
    return 126;
  }
}
