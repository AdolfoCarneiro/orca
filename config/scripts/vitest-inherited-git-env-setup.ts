// Clear Git env inherited from the launching shell or hook (GIT_DIR, GIT_INDEX_FILE, …) so real-Git suites cannot write into an outer repo; tests that need one set it afterwards.
for (const name of Object.keys(process.env).filter((key) => key.startsWith('GIT_'))) {
  delete process.env[name]
}
