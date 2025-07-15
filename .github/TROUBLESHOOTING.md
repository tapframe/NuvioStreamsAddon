# Troubleshooting GitHub Actions

## Release Please Permission Error

If you encounter the error: "GitHub Actions is not permitted to create or approve pull requests", this is due to repository security settings.

### Solution 1: Enable GitHub Actions to Create Pull Requests

1. Go to your repository on GitHub
2. Navigate to **Settings** → **Actions** → **General**
3. Scroll down to **Workflow permissions**
4. Select **Read and write permissions**
5. Check the box **Allow GitHub Actions to create and approve pull requests**
6. Click **Save**

### Solution 2: Use a Personal Access Token (Alternative)

If you prefer not to enable the above setting, you can use a Personal Access Token:

1. Create a Personal Access Token with `repo` and `workflow` scopes
2. Add it as a repository secret named `PAT_TOKEN`
3. Update the release-please action to use this token:

```yaml
- uses: google-github-actions/release-please-action@v4
  id: release
  with:
    release-type: node
    package-name: nuvio-streams-addon
    token: ${{ secrets.PAT_TOKEN }}  # Use PAT instead of GITHUB_TOKEN
```

### What Happened

The Release Please action successfully:
- ✅ Created a release branch
- ✅ Generated the release commit
- ❌ Failed to create the pull request due to permissions

Once you apply either solution above, the workflow will be able to create release pull requests automatically.

### Testing the Fix

After applying the fix:
1. Make a conventional commit (e.g., `feat: add new feature`)
2. Push to the main/master branch
3. The workflow should now successfully create a release PR
4. Review and merge the PR to trigger the actual release