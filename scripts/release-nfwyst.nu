#!/usr/bin/env nu

const package_name = "@nfwyst/pinets-cli"
const core_package_name = "@nfwyst/pinets"
const registry_url = "https://registry.npmjs.org"
const registry_tag = "latest"
const registry_visibility_attempts = 150
const registry_visibility_delay = 2sec
const expected_remote = '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)nfwyst/pinets-cli(?:\.git)?$'
const git_name = "nfwyst"
const git_email = "35720450+nfwyst@users.noreply.github.com"
const release_files = ["package.json" "bun.lock" "THIRD_PARTY_NOTICES"]

def command-text [program: string, args: list<string>] {
    [$program] | append $args | str join " "
}

def capture-result [cwd: path, program: string, args: list<string>] {
    cd $cwd
    do --ignore-errors { run-external $program ...$args } | complete
}

def capture-command [cwd: path, program: string, args: list<string>] {
    let result = (capture-result $cwd $program $args)
    if $result.exit_code != 0 {
        let details = ($"($result.stderr)\n($result.stdout)" | str trim)
        error make $"Command failed: (command-text $program $args)\n($details)"
    }
    $result.stdout | str trim
}

def run-command [cwd: path, program: string, args: list<string>] {
    print $"→ (command-text $program $args)"
    cd $cwd
    run-external $program ...$args
}

def require-tools [] {
    for tool in ["bun" "bunx" "git" "mktemp" "nu" "pinets" "realpath" "tar"] {
        if (which $tool | is-empty) {
            error make $"Required command is unavailable: ($tool)"
        }
    }
}

def package-manifest [repo: path] {
    let path = ($repo | path join "package.json")
    if not ($path | path exists) {
        error make $"Missing package.json: ($path)"
    }
    open $path
}

def require-bun-version [repo: path] {
    let declared = (package-manifest $repo | get --optional packageManager | default "")
    if not ($declared =~ '^bun@[0-9]+\.[0-9]+\.[0-9]+$') {
        error make $"Invalid packageManager declaration in ($repo): ($declared)"
    }
    let expected = ($declared | str replace 'bun@' '')
    let actual = (capture-command $repo "bun" ["--version"])
    if $actual != $expected {
        error make $"Bun version mismatch in ($repo): expected ($expected), found ($actual)"
    }
}

def registry-token [] {
    let existing = ($env.NPM_CONFIG_TOKEN? | default "" | str trim)
    if not ($existing | is-empty) {
        return $existing
    }

    let npmrc = ($nu.home-dir | path join ".npmrc")
    if not ($npmrc | path exists) {
        error make $"Missing registry credentials file: ($npmrc)"
    }
    let matches = (
        open --raw $npmrc
        | lines
        | parse --regex '^//registry\.npmjs\.org/:_authToken=(?<token>.+)$'
    )
    if ($matches | is-empty) {
        error make "registry.npmjs.org authentication is missing; log in before releasing"
    }
    let token = ($matches | first | get token | str trim)
    if ($token | is-empty) {
        error make "npmjs authentication token is empty"
    }
    $token
}

def require-clean [repo: path] {
    let status = (capture-command $repo "git" ["status" "--porcelain=v1" "--untracked-files=all"])
    if not ($status | is-empty) {
        error make $"Repository must be clean before release: ($repo)\n($status)"
    }
}

def require-repo [repo: path, expected_name: string, remote_pattern: string] {
    let manifest = (package-manifest $repo)
    if $manifest.name != $expected_name {
        error make $"Expected ($expected_name), found ($manifest.name) in ($repo)"
    }

    require-clean $repo

    let branch = (capture-command $repo "git" ["branch" "--show-current"])
    if $branch != "main" {
        error make $"Release must run from main, found: ($branch)"
    }

    let remote = (capture-command $repo "git" ["remote" "get-url" "origin"])
    if not ($remote =~ $remote_pattern) {
        error make $"Unexpected origin remote: ($remote)"
    }

    let upstream = (capture-command $repo "git" ["rev-parse" "--abbrev-ref" "--symbolic-full-name" "@{u}"])
    if $upstream != "origin/main" {
        error make $"Expected upstream origin/main, found: ($upstream)"
    }

    run-command $repo "git" ["fetch" "origin" "main"]
    let counts = (
        capture-command $repo "git" ["rev-list" "--left-right" "--count" "HEAD...origin/main"]
        | split row --regex '\s+'
    )
    let behind = ($counts | get 1 | into int)
    if $behind > 0 {
        error make $"Local main is behind origin/main by ($behind) commit(s); fast-forward it first"
    }
}

def next-fork-version [current: string] {
    let rows = (
        $current
        | parse --regex '^(?<base>[0-9]+\.[0-9]+\.[0-9]+)-nfwyst\.(?<revision>[0-9]+)$'
    )
    if ($rows | is-empty) {
        error make $"Version must match <semver>-nfwyst.<number>: ($current)"
    }
    let row = ($rows | first)
    let revision = (($row.revision | into int) + 1)
    $"($row.base)-nfwyst.($revision)"
}

def require-fork-version [value: string] {
    if not ($value =~ '^[0-9]+\.[0-9]+\.[0-9]+-nfwyst\.[0-9]+$') {
        error make $"Version must match <semver>-nfwyst.<number>: ($value)"
    }
}

def registry-info [name: string, version: string] {
    let spec = $"($name)@($version)"
    let result = (capture-result $env.PWD "bun" ["info" "--no-cache" $"--registry=($registry_url)" $spec "--json"])
    if $result.exit_code == 0 {
        return { published: true, data: ($result.stdout | from json) }
    }
    let details = ($"($result.stderr)\n($result.stdout)" | str trim)
    if ($details =~ '(?i)No matching version found|E404|404 Not Found') {
        return { published: false, data: null }
    }
    error make $"Unable to query the package registry for ($spec):\n($details)"
}

def require-published [name: string, version: string] {
    let info = (registry-info $name $version)
    if not $info.published {
        error make $"Required registry package is not published: ($name)@($version)"
    }
}

def verify-published [name: string, version: string, expected_head: string] {
    for attempt in 1..$registry_visibility_attempts {
        let info = (registry-info $name $version)
        if $info.published {
            let actual_version = ($info.data | get version)
            let actual_head = ($info.data | get --optional gitHead)
            if $actual_version != $version {
                error make $"Registry returned unexpected version: ($actual_version)"
            }
            if $actual_head != $expected_head {
                error make $"Registry gitHead mismatch: expected ($expected_head), found ($actual_head)"
            }
            return
        }
        if $attempt < $registry_visibility_attempts {
            sleep $registry_visibility_delay
        }
    }
    error make $"Published package did not become visible: ($name)@($version)"
}

def changed-paths [repo: path] {
    let result = (capture-result $repo "git" ["status" "--porcelain=v1" "--untracked-files=all"])
    if $result.exit_code != 0 {
        let details = ($"($result.stderr)\n($result.stdout)" | str trim)
        error make $"Unable to read repository status:\n($details)"
    }
    if ($result.stdout | str trim | is-empty) {
        return []
    }
    $result.stdout | lines | each {|line| $line | str replace --regex '^.. ' '' }
}

def require-only-release-files [repo: path] {
    let paths = (changed-paths $repo)
    let unexpected = ($paths | where {|path| not ($path in $release_files) })
    if not ($unexpected | is-empty) {
        error make $"Unexpected files changed during release:\n($unexpected | str join '\n')"
    }
}

def require-staged-release-files [repo: path] {
    let staged_text = (capture-command $repo "git" ["diff" "--cached" "--name-only"])
    let staged = if ($staged_text | is-empty) { [] } else { $staged_text | lines | sort }
    let unexpected = ($staged | where {|path| not ($path in $release_files) })
    if not ("package.json" in $staged) or not ($unexpected | is-empty) {
        error make $"Release staging must include package.json and only release files; found: ($staged | str join ', ')"
    }
}

def commit-release [repo: path, version: string] {
    run-command $repo "git" ["add" "--" ...$release_files]
    require-staged-release-files $repo

    let message = $"Release ($package_name) ($version)"
    with-env {
        TRAE_GIT_ATTRIBUTION_HELPER: ""
        GIT_AUTHOR_NAME: $git_name
        GIT_AUTHOR_EMAIL: $git_email
        GIT_COMMITTER_NAME: $git_name
        GIT_COMMITTER_EMAIL: $git_email
    } {
        run-command $repo "git" [
            "-c" $"user.name=($git_name)"
            "-c" $"user.email=($git_email)"
            "commit" "-m" $message
        ]
    }

    let committed_message = (capture-command $repo "git" ["log" "-1" "--format=%B"])
    if ($committed_message =~ '(?im)^(Co-authored-by|Generated-by|Assisted-by|Signed-off-by):|TRAE CLI') {
        error make "Forbidden attribution found in the release commit"
    }

    let author = (capture-command $repo "git" ["log" "-1" "--format=%an <%ae>"])
    let committer = (capture-command $repo "git" ["log" "-1" "--format=%cn <%ce>"])
    let expected_identity = $"($git_name) <($git_email)>"
    if $author != $expected_identity or $committer != $expected_identity {
        error make $"Unexpected Git identity: author=($author), committer=($committer)"
    }
}

def update-third-party-notices [repo: path, core_version: string] {
    let path = ($repo | path join "THIRD_PARTY_NOTICES")
    let source = (open --raw $path)
    let pattern = '(?m)^@nfwyst/pinets [^\r\n]+$'
    if not ($source =~ $pattern) {
        error make "THIRD_PARTY_NOTICES is missing the @nfwyst/pinets version heading"
    }
    let updated = ($source | str replace --regex $pattern $"@nfwyst/pinets ($core_version)")
    if $updated != $source {
        $updated | save --force $path
    }
}

def create-release-archive [repo: path, version: string, expected_head: string] {
    let staging = (mktemp --directory --tmpdir $"pinets-cli-release.XXXXXX")
    for file in ["package.json" "LICENSE" "README.md" "THIRD_PARTY_NOTICES"] {
        cp ($repo | path join $file) $staging
    }
    cp --recursive ($repo | path join "SKILL.md") $staging
    cp --recursive ($repo | path join "dist") $staging

    let staged_manifest_path = ($staging | path join "package.json")
    open $staged_manifest_path
        | upsert gitHead $expected_head
        | to json --indent 2
        | save --force $staged_manifest_path

    print $"→ bun pm pack --ignore-scripts --quiet --destination ($staging)"
    let pack = (capture-result $staging "bun" ["pm" "pack" "--ignore-scripts" "--quiet" "--destination" $staging])
    if $pack.exit_code != 0 {
        rm --recursive --force $staging
        let details = ($"($pack.stderr)\n($pack.stdout)" | str trim)
        error make $"Unable to create release archive:\n($details)"
    }

    let archive = ($staging | path join ($pack.stdout | str trim | path basename))
    let packed_manifest_result = (capture-result $staging "tar" ["-xOf" $archive "package/package.json"])
    if $packed_manifest_result.exit_code != 0 {
        rm --recursive --force $staging
        error make $"Unable to inspect release archive: ($packed_manifest_result.stderr | str trim)"
    }
    let packed_manifest = ($packed_manifest_result.stdout | from json)
    let packed_version = ($packed_manifest | get version | into string)
    let packed_head = ($packed_manifest | get --optional gitHead)
    if $packed_version != $version or $packed_head != $expected_head {
        rm --recursive --force $staging
        error make $"Release archive provenance mismatch: version=($packed_version), gitHead=($packed_head)"
    }

    let archive_entries = (capture-command $staging "tar" ["-tf" $archive] | lines)
    for required in [
        "package/dist/pinets-cli.min.cjs"
        "package/dist/pinets-cli.cjs"
        "package/SKILL.md/claude-code/SKILL.md"
    ] {
        if not ($required in $archive_entries) {
            rm --recursive --force $staging
            error make $"Release archive is missing required file: ($required)"
        }
    }
    { directory: $staging, path: $archive }
}

def confirm-release [version: string, core_version: string, yes: bool] {
    if $yes {
        return
    }
    let phrase = $"publish ($package_name)@($version)"
    print $"Core dependency: ($core_package_name)@($core_version)"
    let answer = (input $"Type '($phrase)' to continue: ")
    if $answer != $phrase {
        error make "Release cancelled"
    }
}

def remove-trae-link [canonical: path] {
    let trae_path = ($nu.home-dir | path join ".trae" "skills" "pinets")
    let path_type = ($trae_path | path type | default "")
    if ($path_type | is-empty) {
        return
    }
    if $path_type != "symlink" {
        error make $"Refusing to remove non-symlink path: ($trae_path)"
    }

    let actual_target = (capture-command $env.PWD "realpath" [$trae_path])
    let expected_target = (capture-command $env.PWD "realpath" [$canonical])
    if $actual_target != $expected_target {
        error make $"Refusing unexpected Trae symlink target: ($actual_target)"
    }

    run-command $env.PWD "bunx" ["--bun" "skills" "remove" "pinets" "--global" "--agent" "trae" "--yes"]
}

def verify-installed-toolchain [version: string] {
    let cli_version = (capture-command $env.PWD "pinets" ["--version"])
    if not ($cli_version | str contains $version) {
        error make $"Global pinets version mismatch:\n($cli_version)"
    }

    let canonical = ($nu.home-dir | path join ".agents" "skills" "pinets")
    remove-trae-link $canonical

    let skill_entry = (
        capture-command $env.PWD "bunx" ["--bun" "skills" "list" "--global" "--json"]
        | from json
        | where name == "pinets"
    )
    if ($skill_entry | length) != 1 {
        error make "Expected exactly one globally installed pinets skill"
    }

    let skill = ($skill_entry | first)
    if $skill.path != ($canonical | into string) {
        error make $"Unexpected pinets skill path: ($skill.path)"
    }
    if $skill.source != "nfwyst/pinets-cli" {
        error make $"Unexpected pinets skill source: ($skill.source)"
    }
    if ($skill.agents | any {|agent| $agent == "Trae" }) {
        error make "Trae-specific pinets link still exists"
    }
    if not (($canonical | path join "SKILL.md") | path exists) {
        error make $"Missing canonical pinets SKILL.md under ($canonical)"
    }

    let trae_path = ($nu.home-dir | path join ".trae" "skills" "pinets")
    if not (($trae_path | path type | default "") | is-empty) {
        error make $"Trae-specific pinets path still exists: ($trae_path)"
    }
}

# Publish the nfwyst pinets CLI, update the global binary, and refresh the canonical pinets skill.
export def main [
    --version: string       # Explicit CLI version; defaults to the next -nfwyst.N revision.
    --core-version: string  # Exact @nfwyst/pinets version to bundle; defaults to package.json.
    --resume                # Reuse the current CLI version after a partial release.
    --dry-run               # Run preflight checks and print the plan without releasing.
    --yes                   # Skip the typed release confirmation.
] {
    require-tools

    let repo = ($env.PROCESS_PATH | path expand | path dirname | path dirname)
    require-repo $repo $package_name $expected_remote
    require-bun-version $repo

    let manifest = (package-manifest $repo)
    let current_version = ($manifest.version | into string)
    let current_core = ($manifest.devDependencies | get $core_package_name | into string)
    let target_version = if not ($version | is-empty) {
        $version
    } else if $resume {
        $current_version
    } else {
        next-fork-version $current_version
    }
    let target_core = if ($core_version | is-empty) { $current_core } else { $core_version }

    require-fork-version $target_version
    require-fork-version $target_core
    if $resume and $target_version != $current_version {
        error make $"--resume requires the current version: ($current_version)"
    }
    if not $resume and $target_version == $current_version {
        error make "Use --resume to release or reinstall the current version"
    }
    if $resume and $target_core != $current_core {
        error make "--resume cannot change the bundled core dependency"
    }

    let npmjs_token = (registry-token)
    let registry_user = (with-env { NPM_CONFIG_TOKEN: $npmjs_token } {
        capture-command $repo "bun" ["pm" $"--registry=($registry_url)" "whoami"]
    })
    require-published $core_package_name $target_core

    let existing = (registry-info $package_name $target_version)
    if $existing.published and not $resume {
        error make $"Version is already published: ($package_name)@($target_version)"
    }

    print ""
    print "Release plan"
    print $"  repository: ($repo)"
    print $"  CLI:        ($current_version) → ($target_version)"
    print $"  core:       ($current_core) → ($target_core)"
    print $"  registry:   ($package_name)@($target_version)"
    print $"  user:       ($registry_user)"
    print "  install:    global pinets + ~/.agents/skills/pinets"
    print ""

    if $dry_run {
        print "Dry run complete; no worktree, commit, push, publish, global CLI, or skill changes were made."
        return
    }

    confirm-release $target_version $target_core $yes

    if $target_core != $current_core {
        run-command $repo "bun" ["add" "--dev" "--exact" $"($core_package_name)@($target_core)" $"--registry=($registry_url)"]
    }
    update-third-party-notices $repo $target_core

    run-command $repo "bun" ["run" "check"]
    run-command $repo "bun" ["run" "test"]
    require-only-release-files $repo

    if $target_version != $current_version {
        run-command $repo "bun" ["pm" "pkg" "set" $"version=($target_version)"]
        run-command $repo "bun" ["install" "--lockfile-only" $"--registry=($registry_url)"]
        require-only-release-files $repo
        run-command $repo "bun" ["run" "check"]
        run-command $repo "bun" ["run" "test"]
        require-only-release-files $repo
        commit-release $repo $target_version
    } else {
        require-clean $repo
    }

    run-command $repo "git" ["push" "origin" "HEAD:main"]
    let release_head = (capture-command $repo "git" ["rev-parse" "HEAD"])
    let published = (registry-info $package_name $target_version)
    if $published.published {
        let published_head = ($published.data | get --optional gitHead)
        if $published_head != $release_head {
            error make $"Published gitHead does not match HEAD: ($published_head) != ($release_head)"
        }
        print $"Registry package already published; continuing installation: ($package_name)@($target_version)"
    } else {
        let release_archive = (create-release-archive $repo $target_version $release_head)
        print $"→ bun publish --access=public --tag=($registry_tag) --registry=($registry_url) ($release_archive.path)"
        try {
            with-env { NPM_CONFIG_TOKEN: $npmjs_token } {
                run-command $repo "bun" [
                    "publish"
                    "--access=public"
                    $"--tag=($registry_tag)"
                    $"--registry=($registry_url)"
                    $release_archive.path
                ]
            }
        } catch {|error|
            rm --recursive --force $release_archive.directory
            error make { msg: $"Unable to publish ($package_name)@($target_version)" inner: [$error] }
        }
        rm --recursive --force $release_archive.directory
        verify-published $package_name $target_version $release_head
    }

    run-command $repo "bun" ["add" "--global" "--exact" $"($package_name)@($target_version)" $"--registry=($registry_url)"]
    run-command $repo "bunx" [
        "--bun"
        "skills" "add" "nfwyst/pinets-cli"
        "--skill" "pinets"
        "--global"
        "--agent" "universal"
        "--yes"
    ]
    verify-installed-toolchain $target_version

    print ""
    print $"Released and installed ($package_name)@($target_version) with ($core_package_name)@($target_core)."
}
