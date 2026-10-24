# Refuses a commit or merge commit made directly on main. Run by the husky hooks.
branch=$(git symbolic-ref --short -q HEAD)
if [ "$branch" = "main" ]; then
  echo "git hook: direct commits to main are not allowed. Create a branch first." >&2
  exit 1
fi
