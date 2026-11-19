# Pipelines — for any diff that touches a CI workflow file

A pipeline runs with the repository's token and secrets, so a defect in it is often a
security line. Routed by path, whatever the request named.

A value a contributor writes, placed straight inside `run:` as `${{ ... }}`, is shell
injection: `github.event.issue.title` or `.body`, `github.event.pull_request.title`, `.body`
or `.head.ref`, `github.head_ref`, `github.event.comment.body`, a commit message, a branch or
label name. The runner pastes it into the script before the shell parses it. `breaks`,
security; the fix passes it through `env:` and the script reads `"$VAR"`, quoted. The same
holds inside the `script:` of `actions/github-script`.
`pull_request_target` or `workflow_run` that checks out the head ref and then runs its code,
an install step included: `breaks`, security.
A third-party action on a moving tag (`@v4`, `@main`): `fragile`; the fix pins the commit SHA
with the tag in a comment.
No `permissions:` block on a workflow that does not need to write: `fragile`; the fix sets
`contents: read` at the top.

The rest of the safe list is the "Safe" section of `pipeline.md` in atlas-ship; read it there
when that skill is installed.

(Routing CI files into review by path: alibaba/open-code-review, Apache-2.0.)
