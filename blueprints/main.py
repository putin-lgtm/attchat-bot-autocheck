# Main Blueprint - Home page and navigation
from flask import Blueprint, render_template

bp = Blueprint('main', __name__)

@bp.route('/')
def index():
    return render_template('index.html', title='KJC Testing API')

@bp.route('/about')
def about():
    return render_template('about.html', title='About')


@bp.route('/k6')
def k6():
    return render_template('k6_interface.html', title='k6 Load Test')