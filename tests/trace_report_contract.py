"""Validate report generation before individual tests inspect Host events."""
if __package__:
    from .normal_graph_identity import selected_graph
else:
    from normal_graph_identity import selected_graph


def validate_report(value, completed):
    selected = selected_graph()
    expected = 'etas.cli.interpreter-report.v2' if selected == 'latest022' else 'etas.cli.interpreter-report.v1'
    assert isinstance(value, dict) and value.get('schema') == expected
    assert value.get('incomplete') is not True
    assert value['outcome']['kind'] == ('completed' if completed else 'failed')
    assert value['termination']['local_work_settled'] is True
    assert isinstance(value['events'], list)
    return value
