# GitHub Releases & Automated Workflow

This project now uses automated releases with [Release Please](https://github.com/googleapis/release-please) and [Renovate](https://renovatebot.com/) for better dependency management and faster Kubernetes deployments.

## 🚀 How It Works

### Automated Releases
- **Release Please** automatically creates release PRs based on [Conventional Commits](https://www.conventionalcommits.org/)
- When merged, it creates GitHub releases with proper semantic versioning
- Automatically updates version numbers in `package.json`, `manifest.json`, and sub-packages
- Generates comprehensive changelogs

### Dependency Management
- **Renovate** automatically creates PRs for dependency updates
- Groups related updates to reduce PR noise
- Provides detailed information about each update
- Integrates seamlessly with the release workflow

### CI/CD Pipeline
- **Continuous Integration** runs tests and validation on every PR
- **Automated Deployment** to Vercel on successful releases
- **Security Scanning** for vulnerabilities and secrets
- **Multi-Node Testing** across Node.js versions 16, 18, and 20

## 📝 Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/) for automatic changelog generation:

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types
- `feat`: New features
- `fix`: Bug fixes
- `perf`: Performance improvements
- `docs`: Documentation changes
- `style`: Code style changes
- `refactor`: Code refactoring
- `test`: Test changes
- `chore`: Maintenance tasks
- `ci`: CI/CD changes
- `build`: Build system changes

### Examples
```bash
feat: add new anime provider support
fix: resolve ShowBox authentication issue
perf: optimize cache performance for large datasets
docs: update deployment instructions
chore(deps): update axios to v1.6.0
```

## 🔄 Release Process

### Automatic (Recommended)
1. Make changes using conventional commits
2. Push to `main` branch
3. Release Please creates a release PR automatically
4. Review and merge the release PR
5. GitHub release is created automatically
6. Deployment happens automatically

### Manual Release
If you need to trigger a release manually:
1. Go to Actions → Release Please
2. Click "Run workflow"
3. Select the branch and run

## 🔧 Renovate Configuration

### Dependency Updates
- **Schedule**: Weekends only to avoid disrupting development
- **Grouping**: Minor/patch updates are grouped together
- **Auto-merge**: Enabled for trusted patch updates
- **Security**: High priority for security updates

### Package Rules
- **Provider Service**: Separate group for `provider-service/` dependencies
- **HiAnime**: Separate group for `providers/hianime/` dependencies
- **Major Updates**: Individual PRs with special labeling
- **Security Updates**: Immediate priority

## 🛠️ Setup Requirements

### GitHub Secrets
For full automation, configure these secrets in your repository:

```bash
# Vercel Deployment (optional)
VERCEL_TOKEN=your_vercel_token
VERCEL_ORG_ID=your_org_id
VERCEL_PROJECT_ID=your_project_id
```

### Renovate Setup
1. Install [Renovate GitHub App](https://github.com/apps/renovate)
2. Configuration is already included in `.github/renovate.json`
3. Renovate will automatically start creating dependency update PRs

## 📊 Benefits for Kubernetes Deployment

### Faster Builds
- **Semantic Versioning**: Clear version tracking for container images
- **Automated Releases**: No manual version bumping
- **Consistent Artifacts**: Reproducible builds with proper tagging

### Better Dependency Management
- **Security Updates**: Automatic vulnerability patching
- **Predictable Updates**: Scheduled dependency updates
- **Reduced Conflicts**: Grouped updates minimize merge conflicts

### Production Readiness
- **Multi-Environment Testing**: CI runs across multiple Node.js versions
- **Security Scanning**: Automated vulnerability detection
- **Artifact Generation**: Release assets for deployment

## 🏷️ Version Strategy

- **Major** (1.0.0 → 2.0.0): Breaking changes
- **Minor** (1.0.0 → 1.1.0): New features, backward compatible
- **Patch** (1.0.0 → 1.0.1): Bug fixes, backward compatible

## 📋 Workflow Files

- `.github/workflows/release-please.yml`: Main release workflow
- `.github/workflows/ci.yml`: Continuous integration
- `.github/renovate.json`: Renovate configuration
- `.release-please-config.json`: Release Please settings
- `.release-please-manifest.json`: Version tracking

## 🔍 Monitoring

### Dependency Dashboard
Renovate creates a "Dependency Dashboard" issue that shows:
- Pending updates
- Failed updates
- Configuration status
- Update schedule

### Release Status
Check the Actions tab for:
- CI status on PRs
- Release creation status
- Deployment status
- Security scan results

## 🚨 Troubleshooting

### Release Please Not Creating PRs
1. Check commit message format
2. Ensure commits are on the main branch
3. Verify `.release-please-config.json` is valid

### Renovate Not Working
1. Check if Renovate app is installed
2. Verify `.github/renovate.json` syntax
3. Check repository permissions

### CI Failures
1. Check Node.js version compatibility
2. Verify all required files exist
3. Check for syntax errors in JSON files

## 📚 Additional Resources

- [Release Please Documentation](https://github.com/googleapis/release-please)
- [Renovate Documentation](https://docs.renovatebot.com/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)