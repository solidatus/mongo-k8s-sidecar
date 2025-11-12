#!/bin/bash

set -eux

GITHUB_BEARER_TOKEN=$GITHUB_PAT
GITHUB_REPOSITORY_NAME=$GITHUB_REPOSITORY_NAME
RELEASE_NEW_VERSION=$RELEASE_NEW_VERSION

echo "Creating release..."

echo "Getting latest release information..."
latestReleaseResponse=$(curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_BEARER_TOKEN" \
    https://api.github.com/repos/solidatus/$GITHUB_REPOSITORY_NAME/releases/latest)
echo $latestReleaseResponse

if [[ ! "$latestReleaseResponse" =~ "\"status\": \"404\"" ]]; then
    echo "Found latest release."

    oldTag=$(echo $latestReleaseResponse | grep -o '"tag_name": "[^"]*' | grep -o '[^"]*$')
    echo "Found old release tag: \"$oldTag\""

    previousTagName=', "previous_tag_name": "'$oldTag'"'
else
    echo "Latest release not found"
    previousTagName=''
fi

notesBody='{ "tag_name": "'$RELEASE_NEW_VERSION'", "target_commitish": "stable"'$previousTagName' }'
echo "Notes body: \"$notesBody\""

echo "Generating release notes string..."
autoReleaseNotes=$(curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_BEARER_TOKEN" \
    https://api.github.com/repos/solidatus/$GITHUB_REPOSITORY_NAME/releases/generate-notes \
    -d "$notesBody")

echo $autoReleaseNotes

# Find the actual body of the release notes in returned JSON
autoReleaseNotes=$(echo $autoReleaseNotes | grep -o '"body": "[^"]*' | grep -o '[^"]*$')

echo $autoReleaseNotes

# Replaces VCS root labelling, creates new tag
echo "Creating new tag..."
git tag $RELEASE_NEW_VERSION
git push origin $RELEASE_NEW_VERSION
echo "Created new tag: $RELEASE_NEW_VERSION"

releaseBody='{ "tag_name": "'$RELEASE_NEW_VERSION'", "target_commitish": "stable" ,"name": "'$RELEASE_NEW_VERSION'", "body": "This is an automatically generated release. \n'$autoReleaseNotes'", "draft": false, "prerelease": false, "generate_release_notes": false }'
echo "Release body: \"$releaseBody\""

echo "Creating release..."
releaseJson=$(curl -sS \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer $GITHUB_BEARER_TOKEN" \
    https://api.github.com/repos/solidatus/$GITHUB_REPOSITORY_NAME/releases \
    -d "$releaseBody")

echo $releaseJson

# Get the ID of the new release
# First pipe grabs the first ID entry, which will be the release tag ID
# Second pipe replaces "id": with empty to leave the number
releaseId=$(echo $releaseJson | grep -o '"id": [[:digit:]]*' | head -1 | sed 's/"id": //')

echo "Created release with ID: $releaseId, name: $RELEASE_NEW_VERSION"

echo "Release complete."
