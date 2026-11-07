# Description

Please include a summary of the changes and the related issue. Include relevant motivation and context.

Fixes # (issue)

## Type of Change

Please delete options that are not relevant.

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Agent skill update (`skills/agent-box/SKILL.md`)
- [ ] Code refactoring
- [ ] Test improvements

## How Has This Been Tested?

Please describe the tests that you ran to verify your changes.

- [ ] `tests/smoke.sh` with Apple's `container`
- [ ] `tests/smoke.sh` with Docker (which: Docker Desktop, OrbStack, Colima, Docker Engine)
- [ ] `tests/smoke.sh` with Podman
- [ ] Manual testing in the viewer

## Checklist

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my code
- [ ] `shellcheck -S warning` passes on the scripts I changed
- [ ] I have made corresponding changes to the README and, if agents use it, to the skill
- [ ] My changes generate no new warnings
- [ ] Passwords never reach a command line, a log or an agent's output
- [ ] I have used conventional commit messages

## Additional Notes

Add any additional notes or context here.
