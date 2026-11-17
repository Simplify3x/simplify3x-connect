import { splitAcceptanceCriteria, toStory } from './mapper.js';

describe('splitAcceptanceCriteria', () => {
  it('splits an SQA HTML blob into individual acceptance criteria', () => {
    const html =
      '<p><strong>AC1 – Display Checkout Form</strong><br>Given the customer has products,<br>' +
      'When the customer clicks <strong>Checkout</strong>,<br>Then the form is displayed.</p>' +
      '<p><strong>AC2 – Submit Valid Information</strong><br>Given the form is displayed,<br>' +
      'Then the user lands on <strong>Order Overview</strong>.</p>';

    const ac = splitAcceptanceCriteria(html);

    expect(ac).toHaveLength(2);
    expect(ac[0]).toContain('AC1 – Display Checkout Form');
    expect(ac[0]).toContain('Given the customer has products');
    expect(ac[0]).not.toContain('<');
    expect(ac[1]).toContain('AC2 – Submit Valid Information');
    expect(ac[1]).toContain('Order Overview');
  });

  it('splits a list-based blob', () => {
    const html =
      '<ul><li>User can sign in with valid credentials</li><li>Invalid credentials show an error</li></ul>';
    expect(splitAcceptanceCriteria(html)).toEqual([
      'User can sign in with valid credentials',
      'Invalid credentials show an error',
    ]);
  });

  it('decodes entities and collapses whitespace', () => {
    expect(splitAcceptanceCriteria('<p>A&nbsp;&amp;&nbsp;B</p>')).toEqual(['A & B']);
  });

  it('accepts an array of blobs (each item can itself hold several ACs)', () => {
    const raw = ['<p>First criterion</p><p>Second criterion</p>', 'Third criterion'];
    expect(splitAcceptanceCriteria(raw)).toEqual([
      'First criterion',
      'Second criterion',
      'Third criterion',
    ]);
  });

  it('falls back to newline splitting for plain text', () => {
    expect(splitAcceptanceCriteria('one\ntwo\r\n\nthree')).toEqual(['one', 'two', 'three']);
  });

  it('returns nothing for empty / null input', () => {
    expect(splitAcceptanceCriteria(undefined)).toEqual([]);
    expect(splitAcceptanceCriteria(null)).toEqual([]);
    expect(splitAcceptanceCriteria('   ')).toEqual([]);
  });
});

describe('toStory acceptance criteria', () => {
  it('exposes the split ACs on the story', () => {
    const story = toStory({
      id: 897,
      code: 'US-897',
      name: 'Checkout',
      acceptanceCriteria: '<p>AC one</p><p>AC two</p>',
    });
    expect(story.acceptanceCriteria).toEqual(['AC one', 'AC two']);
  });
});
