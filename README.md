# Jira Logs

## Installation

Install packages:
```shell script
npm install
```

Copy the example YML file:
```shell script
cp jira.yml.example jira.yml
```

Add custom values to jira.yml

NOTE: the name of the person (firstname + lastname) is critical and must be exact! If not, it won't get matched and
thus the worklogs won't get downloaded for this specific person

## Run

```shell script
./jira-logs --startDate 2020-07-01 --endDate 2020-07-31 --group developers
```

This will retrieve work logs from Jira(s). Of course select any period you wish.

To get help use:
```shell script
./jira-logs --help
```

