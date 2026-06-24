/*
 * WASM build stubs for LLVM/clang. The build renames wait4 → __wait4_disabled via
 * -Dwait4=__wait4_disabled (LLVM's Program.cpp uses subprocess wait, which an in-process
 * integrated-cc1 clang never exercises). Provide the symbol so the link resolves; it just
 * fails like a process that can't be reaped. Linked into every executable via
 * CMAKE_EXE_LINKER_FLAGS so no LLVM object needs recompiling.
 */
int __wait4_disabled(int pid, int *wstatus, int options, void *rusage) {
  (void)pid;
  (void)wstatus;
  (void)options;
  (void)rusage;
  return -1;
}
